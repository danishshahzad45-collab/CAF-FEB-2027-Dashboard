const DEFAULT_MODEL = "gpt-5.6";
const MAX_BODY = 18 * 1024 * 1024;

function cors(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "https://raw.githack.com").split(",").map(v => v.trim());
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (allowed.includes("*") || allowed.includes(origin)) h["Access-Control-Allow-Origin"] = allowed.includes("*") ? "*" : origin;
  return h;
}
function reply(data, status, h) {
  return new Response(JSON.stringify(data), {status, headers: {"Content-Type":"application/json; charset=utf-8", ...h}});
}
function auth(req, env) {
  const expected = String(env.APP_ACCESS_TOKEN || "");
  const actual = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!expected || !actual || expected.length !== actual.length) return false;
  let diff = 0;
  for (let i=0;i<expected.length;i++) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0;
}
function getText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const out = [];
  for (const item of data.output || []) for (const c of item.content || []) if (c.type === "output_text" && c.text) out.push(c.text);
  return out.join("\n\n").trim();
}
function prompt(p) {
  const max = Math.max(1, Math.min(100, Number(p.maxMarks) || 10));
  return [
    "You are a rigorous ICAP CAF examiner and tutor. You are not ICAP and cannot issue official marks.",
    "SUBJECT: " + (p.subject || "Not specified"),
    "CHAPTER: " + (p.chapter || "Not specified"),
    "MAXIMUM MARKS: " + max,
    "ANSWER TYPE: " + (p.answerType || "Mixed"),
    "QUESTION:\n" + (p.question || ""),
    "STUDENT ANSWER:\n" + (p.answerText || "[No typed answer; read the uploaded register photos.]"),
    "DASHBOARD WORKED REFERENCE (may be a study guide, not an official scheme):\n" + (p.referenceAnswer || "Not supplied"),
    p.officialScheme ? "An ICAP suggested answer / marking-plan PDF is attached. Use its allocation where readable." : "No official marking plan is attached. Mark strictly but label the score as an estimate, not an official ICAP mark.",
    "Do not invent official examiner comments, examiner quotations, past-paper provenance or marking allocations. If no official comments are supplied, write: Official examiner comments not supplied.",
    "For calculations, recompute figures, formulas, units, rates, hours, signs, variances and totals. Separate method marks from final-answer marks.",
    "For FAR 1 check IFRS recognition, measurement, journals, dates, presentation and disclosure. For Management Accounting check formulas, relevant standard/actual bases, workings and interpretation. For DSR link definitions to scenario-specific risks, impacts and matching controls.",
    "Read handwriting carefully. Identify any unreadable figure instead of guessing.",
    "First line must be exactly: ESTIMATED SCORE: <number>/" + max,
    "Then give: requirement-wise marks table; method/application marks and deductions; corrected figures/workings; missing treatment/formula/risk-control application; presentation and exam technique; examiner-style summary; corrected exam-ready solution in simple Roman Urdu / English; three targeted practice tasks."
  ].join("\n\n");
}
function score(text) {
  const m = text.match(/ESTIMATED\s+SCORE\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*([0-9]+(?:\.[0-9]+)?)/i);
  return m ? Math.max(0, Math.min(Number(m[1]), Number(m[2]))) : undefined;
}

export default {
  async fetch(request, env) {
    const h = cors(request, env);
    if (request.method === "OPTIONS") return new Response(null, {status:204, headers:h});
    const url = new URL(request.url);
    if (url.pathname !== "/health" && url.pathname !== "/mark") return reply({ok:false,error:"Not found"},404,h);
    if (!auth(request, env)) return reply({ok:false,error:"Unauthorized. Check APP_ACCESS_TOKEN."},401,h);
    if (url.pathname === "/health" && request.method === "GET") return reply({ok:true,model:env.OPENAI_MODEL || DEFAULT_MODEL},200,h);
    if (url.pathname !== "/mark" || request.method !== "POST") return reply({ok:false,error:"Method not allowed"},405,h);
    if (!env.OPENAI_API_KEY) return reply({ok:false,error:"Worker secret OPENAI_API_KEY is not configured."},500,h);
    if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY) return reply({ok:false,error:"Payload too large. Use fewer or smaller photos."},413,h);
    try {
      const body = await request.json();
      const p = body.payload || {};
      if (!String(p.question || "").trim()) return reply({ok:false,error:"Question is required."},400,h);
      const content = [{type:"input_text",text:prompt(p)}];
      const images = Array.isArray(body.images) ? body.images : [];
      if (images.length > 5) return reply({ok:false,error:"Maximum 5 photos per attempt."},400,h);
      for (let i=0;i<images.length;i++) {
        const image = images[i];
        if (typeof image !== "string" || image.length > 7*1024*1024 || !/^data:image\/(jpeg|png|webp);base64,/i.test(image)) throw new Error("Photo " + (i+1) + " must be JPG, PNG or WebP and within the size limit.");
        content.push({type:"input_image",image_url:image,detail:"high"});
      }
      if (body.scheme) {
        const f = body.scheme;
        if (typeof f.file_data !== "string" || f.file_data.length > 16*1024*1024 || !f.file_data.startsWith("data:application/pdf;base64,")) throw new Error("Marking plan must be a PDF under 12 MB.");
        content.push({type:"input_file",filename:String(f.filename || "ICAP-marking-plan.pdf").replace(/[^A-Za-z0-9._-]/g,"_").slice(0,100),file_data:f.file_data,detail:"high"});
      }
      const response = await fetch("https://api.openai.com/v1/responses", {
        method:"POST",
        headers:{"Authorization":"Bearer " + env.OPENAI_API_KEY,"Content-Type":"application/json"},
        body:JSON.stringify({model:env.OPENAI_MODEL || DEFAULT_MODEL,store:false,max_output_tokens:6000,input:[{role:"user",content}]})
      });
      const data = await response.json();
      if (!response.ok) return reply({ok:false,error:(data.error && data.error.message) || ("OpenAI API HTTP " + response.status)},502,h);
      const feedback = getText(data);
      if (!feedback) return reply({ok:false,error:"Model returned no readable feedback."},502,h);
      return reply({ok:true,feedback,estimatedMarks:score(feedback),model:data.model || env.OPENAI_MODEL || DEFAULT_MODEL},200,h);
    } catch (e) {
      return reply({ok:false,error:e && e.message || "Unexpected marking error."},400,h);
    }
  }
};