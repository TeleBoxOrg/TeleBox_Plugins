import { Plugin } from "@utils/pluginBase"; import { getPrefixes } from "@utils/pluginManager"; import { Api } from "teleproto"; import * as fs from "fs/promises"; import path from "path"; import axios from "axios"; import { createDirectoryInAssets } from "@utils/pathHelpers";  

const pfx = getPrefixes(); const mp = pfx[0];
const DD = createDirectoryInAssets("checkapi"); const KF = path.join(DD, "keys.json");

// ── Types ──
interface SK { name: string; key: string; baseUrl?: string; provider?: string; addedAt: number; }
interface PI { provider: string; displayName: string; baseUrl: string; chatUrl: string; modelsUrl?: string; balanceUrl?: string; confidence: "high"|"medium"|"low"; headers: Record<string,string>; authHeader: string; }
interface AR { ok: boolean; data?: unknown; status?: number; error?: string; headers?: Record<string,string>; elapsedMs?: number; }
interface CTR { ok: boolean; text?: string; model?: string; usage?: {prompt:number;completion:number;total:number}; elapsedMs?: number; error?: string; headers?: Record<string,string>; }

// ── Persistence ──
async function lk(): Promise<SK[]> { try { await fs.mkdir(DD,{recursive:true}); return JSON.parse(await fs.readFile(KF,"utf8")); } catch { return []; } }
async function sk(k: SK[]): Promise<void> { await fs.mkdir(DD,{recursive:true}); await fs.writeFile(KF,JSON.stringify(k,null,2),"utf8"); }
function mk(k: string): string { return k.length<=8?"***":k.slice(0,7)+"..."+k.slice(-4); }
function isUrl(s: string): boolean { return /^(https?:\/\/|.+\.[a-z]{2,}(?:\/|$|:\d+)|.+\/v\d)/i.test(s)||s.includes("://"); }
function nu(s: string): string { let u=s.trim(); if(!/^https?:\/\//i.test(u))u="https://"+u; return u.replace(/\/+$/,""); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ge(e:unknown):string{const o=e as any; return String(o?.message||o?.stderr||e||"未知错误");}
function fh(h?:Record<string,string>):string{if(!h||!Object.keys(h).length)return"";const l:string[]=[];for(const[k,v]of Object.entries(h)){l.push(`  ⚡ ${k.replace(/-/g," ")}: ${v}`);}return l.join("\n");}

// ── Smart input parser: curl / env / json ──
function parseCurl(s: string): { key?: string; url?: string } | null {
  const u = s.match(/(?:-H\s+['"]?(?:Authorization|X-API-Key|x-api-key|api-key):?\s*(?:Bearer\s+)?)([^\s'"]+)/i);
  const url = s.match(/(?:curl\s+(?:-X\s+\w+\s+)?['"]?)?(https?:\/\/[^\s'"]+)/i);
  if (u && url) return { key: u[1], url: url[1] };
  return null;
}
function parseEnv(s: string): { key?: string } | null {
  const m = s.match(/^(?:export\s+)?(\w*API[_\s]*(?:KEY|TOKEN|SECRET)\w*)\s*=\s*['"]?([^\s'"]+)['"]?$/im);
  if (m) return { key: m[2] };
  return null;
}

// ── Provider detection (enhanced) ──
function dp(key: string, baseUrl?: string): PI {
  const t = key.trim();

  // ── URL hostname detection (before key-based) ──
  if (baseUrl) {
    const u = baseUrl.replace(/\/+$/,"");
    const host = (()=>{try{return new URL(u).hostname;}catch{return u;}})();
    const h: Record<string,string> = {};
    // Smart provider detection from hostname
    if (host.includes("openrouter")) {
      h["HTTP-Referer"] = "https://t.me/telebox_next";
      return {provider:"openrouter",displayName:`OpenRouter (${host})`,baseUrl:u,chatUrl:`${u}/chat/completions`,modelsUrl:`${u}/models`,balanceUrl:`${u.replace(/\/api\/v1.*$/,"")}/api/v1/auth/key`,confidence:"high",headers:h,authHeader:`Bearer ${t}`};
    }
    if (host.includes("groq")) return {provider:"groq",displayName:`Groq (${host})`,baseUrl:u,chatUrl:`${u}/chat/completions`,modelsUrl:`${u}/models`,confidence:"high",headers:{},authHeader:`Bearer ${t}`};
    if (host.includes("together")) return {provider:"together",displayName:`Together AI (${host})`,baseUrl:u,chatUrl:`${u}/chat/completions`,modelsUrl:`${u}/models`,confidence:"high",headers:{},authHeader:`Bearer ${t}`};
    if (host.includes("mistral")) return {provider:"mistral",displayName:`Mistral (${host})`,baseUrl:u,chatUrl:`${u}/chat/completions`,modelsUrl:`${u}/models`,confidence:"high",headers:{},authHeader:`Bearer ${t}`};
    if (host.includes("cohere")) return {provider:"cohere",displayName:`Cohere (${host})`,baseUrl:u,chatUrl:u.includes("/v2")?`${u}/chat`:`${u}/v2/chat`,confidence:"medium",headers:{},authHeader:`Bearer ${t}`};
    if (host.includes("perplexity")) return {provider:"perplexity",displayName:`Perplexity (${host})`,baseUrl:u,chatUrl:`${u}/chat/completions`,modelsUrl:`${u}/models`,confidence:"high",headers:{},authHeader:`Bearer ${t}`};
    if (host.includes("fireworks")) return {provider:"fireworks",displayName:`Fireworks (${host})`,baseUrl:u,chatUrl:`${u}/chat/completions`,modelsUrl:`${u}/models`,confidence:"high",headers:{},authHeader:`Bearer ${t}`};
    if (host.includes("replicate")) return {provider:"replicate",displayName:`Replicate (${host})`,baseUrl:u,chatUrl:`${u}/v1/chat/completions`,modelsUrl:`${u}/v1/models`,confidence:"medium",headers:{},authHeader:`Bearer ${t}`};
    if (host.includes("siliconflow")) return {provider:"siliconflow",displayName:`SiliconFlow (${host})`,baseUrl:u,chatUrl:`${u}/chat/completions`,modelsUrl:`${u}/models`,confidence:"medium",headers:{},authHeader:`Bearer ${t}`};if (host.includes("nvidia")||host.includes("nim")) return {provider:"nvidia",displayName:`NVIDIA NIM (${host})`,baseUrl:u,chatUrl:`${u}/chat/completions`,modelsUrl:`${u}/models`,confidence:"medium",headers:{},authHeader:`Bearer ${t}`};if (host.includes("novita")) return {provider:"novita",displayName:`Novita (${host})`,baseUrl:u,chatUrl:`${u}/chat/completions`,modelsUrl:`${u}/models`,confidence:"medium",headers:{},authHeader:`Bearer ${t}`};if (host.includes("cerebras")) return {provider:"cerebras",displayName:`Cerebras (${host})`,baseUrl:u,chatUrl:`${u}/chat/completions`,modelsUrl:`${u}/models`,confidence:"high",headers:{},authHeader:`Bearer ${t}`};if (host.includes("azure")||host.includes("openai.azure")) return {provider:"azure",displayName:`Azure OpenAI (${host})`,baseUrl:u,chatUrl:`${u}/chat/completions?api-version=2024-10-21`,modelsUrl:`${u}/models?api-version=2024-10-21`,confidence:"high",headers:{"api-key":t},authHeader:""};if (host.includes("vercel")) return {provider:"vercel",displayName:`Vercel AI Gateway (${host})`,baseUrl:u,chatUrl:`${u}/chat/completions`,modelsUrl:`${u}/models`,confidence:"medium",headers:{},authHeader:`Bearer ${t}`};
    if (host.includes("deepinfra")) return {provider:"deepinfra",displayName:`DeepInfra (${host})`,baseUrl:u,chatUrl:`${u}/chat/completions`,modelsUrl:`${u}/models`,confidence:"medium",headers:{},authHeader:`Bearer ${t}`};
    if (host.includes("localhost")||host.includes("127.0.0.1")||host.includes("ollama")) return {provider:"ollama",displayName:`Ollama (${host})`,baseUrl:u,chatUrl:`${u}/chat/completions`,modelsUrl:`${u}/tags`,confidence:"high",headers:{},authHeader:""};
    if (host.includes("generativelanguage")||host.includes("googleapis")) return {provider:"gemini",displayName:`Gemini (${host})`,baseUrl:u,chatUrl:`${u}/v1beta/models/gemini-2.5-flash:generateContent`,modelsUrl:`${u}/v1beta/models`,confidence:"high",headers:{},authHeader:""};
    if (host.includes("anthropic")) return {provider:"anthropic",displayName:`Anthropic (${host})`,baseUrl:u,chatUrl:`${u}/v1/messages`,modelsUrl:`${u}/v1/models`,confidence:"high",headers:{"x-api-key":t,"anthropic-version":"2023-06-01","content-type":"application/json"},authHeader:""};
    if (host.includes("deepseek")) return {provider:"deepseek",displayName:`DeepSeek (${host})`,baseUrl:u,chatUrl:`${u}/chat/completions`,modelsUrl:`${u}/models`,balanceUrl:`${u.replace(/\/v\d.*$/,"")}/user/balance`,confidence:"high",headers:{},authHeader:`Bearer ${t}`};
    if (host.includes("x.ai")) return {provider:"xai",displayName:`xAI (${host})`,baseUrl:u,chatUrl:`${u}/chat/completions`,modelsUrl:`${u}/models`,confidence:"high",headers:{},authHeader:`Bearer ${t}`};
    // Generic OpenAI-compatible fallback
    return {provider:"custom",displayName:`自定义 (${host})`,baseUrl:u,chatUrl:`${u}/chat/completions`,modelsUrl:`${u}/models`,confidence:"medium",headers:h,authHeader:`Bearer ${t}`};
  }

  // ── Key prefix detection ──
  if (/^sk-ant-/i.test(t)) return {provider:"anthropic",displayName:"Anthropic",baseUrl:"https://api.anthropic.com",chatUrl:"https://api.anthropic.com/v1/messages",modelsUrl:"https://api.anthropic.com/v1/models",confidence:"high",headers:{"x-api-key":t,"anthropic-version":"2023-06-01","content-type":"application/json"},authHeader:""};
  if (/^sk-or-v1-/i.test(t)) return {provider:"openrouter",displayName:"OpenRouter",baseUrl:"https://openrouter.ai/api/v1",chatUrl:"https://openrouter.ai/api/v1/chat/completions",modelsUrl:"https://openrouter.ai/api/v1/models",balanceUrl:"https://openrouter.ai/api/v1/auth/key",confidence:"high",headers:{"HTTP-Referer":"https://t.me/telebox_next"},authHeader:`Bearer ${t}`};
  if (/^gsk_/i.test(t)) return {provider:"groq",displayName:"Groq",baseUrl:"https://api.groq.com/openai/v1",chatUrl:"https://api.groq.com/openai/v1/chat/completions",modelsUrl:"https://api.groq.com/openai/v1/models",confidence:"high",headers:{},authHeader:`Bearer ${t}`};
  if (/^tgp_|^together/i.test(t)) return {provider:"together",displayName:"Together AI",baseUrl:"https://api.together.xyz/v1",chatUrl:"https://api.together.xyz/v1/chat/completions",modelsUrl:"https://api.together.xyz/v1/models",confidence:"high",headers:{},authHeader:`Bearer ${t}`};
  if (/^pplx-/i.test(t)) return {provider:"perplexity",displayName:"Perplexity",baseUrl:"https://api.perplexity.ai",chatUrl:"https://api.perplexity.ai/chat/completions",modelsUrl:"https://api.perplexity.ai/models",confidence:"high",headers:{},authHeader:`Bearer ${t}`};
  if (/^r8_/i.test(t)) return {provider:"replicate",displayName:"Replicate",baseUrl:"https://api.replicate.com/v1",chatUrl:"https://api.replicate.com/v1/chat/completions",modelsUrl:"https://api.replicate.com/v1/models",confidence:"medium",headers:{},authHeader:`Bearer ${t}`};
  if (/^fw_/i.test(t)) return {provider:"fireworks",displayName:"Fireworks",baseUrl:"https://api.fireworks.ai/inference/v1",chatUrl:"https://api.fireworks.ai/inference/v1/chat/completions",modelsUrl:"https://api.fireworks.ai/inference/v1/models",confidence:"high",headers:{},authHeader:`Bearer ${t}`};
  if (/^sk-/i.test(t)) {
    if (t.length<40) return {provider:"deepseek",displayName:"DeepSeek",baseUrl:"https://api.deepseek.com",chatUrl:"https://api.deepseek.com/v1/chat/completions",modelsUrl:"https://api.deepseek.com/v1/models",balanceUrl:"https://api.deepseek.com/user/balance",confidence:"medium",headers:{},authHeader:`Bearer ${t}`};
    return {provider:"openai",displayName:"OpenAI",baseUrl:"https://api.openai.com",chatUrl:"https://api.openai.com/v1/chat/completions",modelsUrl:"https://api.openai.com/v1/models",balanceUrl:"https://api.openai.com/v1/dashboard/billing/subscription",confidence:"high",headers:{},authHeader:`Bearer ${t}`};
  }
  if (/^xai-/i.test(t)) return {provider:"xai",displayName:"xAI (Grok)",baseUrl:"https://api.x.ai",chatUrl:"https://api.x.ai/v1/chat/completions",modelsUrl:"https://api.x.ai/v1/models",confidence:"high",headers:{},authHeader:`Bearer ${t}`};
  if (/^AIza/i.test(t)) return {provider:"gemini",displayName:"Google Gemini",baseUrl:"https://generativelanguage.googleapis.com",chatUrl:"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",modelsUrl:"https://generativelanguage.googleapis.com/v1beta/models",confidence:"high",headers:{},authHeader:""};
  if (/^co-|^cohere/i.test(t)) return {provider:"cohere",displayName:"Cohere",baseUrl:"https://api.cohere.com/v2",chatUrl:"https://api.cohere.com/v2/chat",confidence:"medium",headers:{"accept":"application/json"},authHeader:`Bearer ${t}`};
  if (/^hf_/i.test(t)) return {provider:"huggingface",displayName:"HuggingFace",baseUrl:"https://api-inference.huggingface.co",chatUrl:"https://api-inference.huggingface.co/v1/chat/completions",confidence:"low",headers:{},authHeader:`Bearer ${t}`};if (/^nvapi-/i.test(t)) return {provider:"nvidia",displayName:"NVIDIA NIM",baseUrl:"https://integrate.api.nvidia.com/v1",chatUrl:"https://integrate.api.nvidia.com/v1/chat/completions",modelsUrl:"https://integrate.api.nvidia.com/v1/models",confidence:"high",headers:{},authHeader:`Bearer ${t}`};if (/[a-f0-9]{32}/i.test(t)&&t.length===32) return {provider:"azure",displayName:"Azure OpenAI",baseUrl:"",chatUrl:"",confidence:"medium",headers:{"api-key":t},authHeader:""};

  if (t.length>20) return {provider:"openai",displayName:"OpenAI（推测）",baseUrl:"https://api.openai.com",chatUrl:"https://api.openai.com/v1/chat/completions",modelsUrl:"https://api.openai.com/v1/models",confidence:"low",headers:{},authHeader:`Bearer ${t}`};
  return {provider:"unknown",displayName:"未知",baseUrl:"",chatUrl:"",confidence:"low",headers:{},authHeader:""};
}

// ── HTTP (with retry) ──
async function ag(url:string,hdrs:Record<string,string>,tms=15000,retries=2): Promise<AR>{for(let i=0;i<=retries;i++){const s=Date.now();try{const r=await axios.get(url,{headers:hdrs,timeout:tms,validateStatus:()=>true,httpAgent:new (require("http").Agent)({keepAlive:true})});const e=Date.now()-s;const a:AR={ok:r.status>=200&&r.status<300,data:r.data,status:r.status,elapsedMs:e};const h:Record<string,string>={};for(const[k,v]of Object.entries(r.headers as Record<string,string>||{})){if(/rate.?limit|retry.?after|x-ratelimit|ratelimit|quota/i.test(k))h[k]=String(v);}if(Object.keys(h).length)a.headers=h;if(!a.ok)a.error=`HTTP ${r.status}: ${JSON.stringify(r.data).slice(0,200)}`;return a;}catch(e:unknown){if(i===retries)return{ok:false,error:ge(e),elapsedMs:Date.now()-s};await new Promise(r=>setTimeout(r,1000*(i+1)));}}return{ok:false,error:"retry exhausted"};}
async function ap(url:string,hdrs:Record<string,string>,body:unknown,tms=30000,retries=1): Promise<AR>{for(let i=0;i<=retries;i++){const s=Date.now();try{const r=await axios.post(url,body,{headers:hdrs,timeout:tms,validateStatus:()=>true});const e=Date.now()-s;const a:AR={ok:r.status>=200&&r.status<300,data:r.data,status:r.status,elapsedMs:e};const h:Record<string,string>={};for(const[k,v]of Object.entries(r.headers as Record<string,string>||{})){if(/rate.?limit|retry.?after|x-ratelimit|ratelimit|quota/i.test(k))h[k]=String(v);}if(Object.keys(h).length)a.headers=h;if(!a.ok){const d=r.data as Record<string,unknown>|undefined;a.error=d?.error&&typeof d.error==="object"?String((d.error as Record<string,unknown>).message||JSON.stringify(d.error)):`HTTP ${r.status}: ${JSON.stringify(r.data).slice(0,200)}`;}return a;}catch(e:unknown){if(i===retries)return{ok:false,error:ge(e),elapsedMs:Date.now()-s};await new Promise(r=>setTimeout(r,1000*(i+1)));}}return{ok:false,error:"retry exhausted"};}

// ── Chat test ──
async function ct(provider:string,key:string,baseUrl:string,askText?:string): Promise<CTR>{const q=askText||"say ok";const info=dp(key,baseUrl);
  if(provider==="gemini"){const gemBase=info.baseUrl||"https://generativelanguage.googleapis.com";const url=gemBase.includes("v1beta")?`${gemBase}/models/gemini-2.5-flash:generateContent`:`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`;const params=gemBase.includes("generativelanguage")?`?key=${key}`:"";const r=await ap(`${url}${params}`,{"content-type":"application/json"},{contents:[{parts:[{text:q}]}],generationConfig:{maxOutputTokens:50,temperature:0}},20000);if(r.ok){const d=r.data as Record<string,unknown>|undefined;const cs=d?.candidates as Array<Record<string,unknown>>|undefined;const ct=cs?.[0]?.content as Record<string,unknown>|undefined;const ps=ct?.parts as Array<Record<string,string>>|undefined;const tx=ps?.map(p=>p.text||"").join("")||"";const u=d?.usageMetadata as Record<string,number>|undefined;return{ok:true,text:tx,model:"gemini-2.5-flash",usage:u?{prompt:u.promptTokenCount||0,completion:u.candidatesTokenCount||0,total:u.totalTokenCount||0}:undefined,elapsedMs:r.elapsedMs,headers:r.headers};}return{ok:false,error:r.error,elapsedMs:r.elapsedMs};}
  if(provider==="anthropic"){const r=await ap(info.chatUrl,info.headers,{model:"claude-3.5-haiku-20241022",max_tokens:50,messages:[{role:"user",content:q}]},20000);if(r.ok){const d=r.data as Record<string,unknown>|undefined;const ct=(d?.content as Array<Record<string,unknown>>|undefined)?.[0];const tx=String(ct?.text||"");const u=d?.usage as Record<string,number>|undefined;return{ok:true,text:tx,model:String(d?.model||"claude"),usage:u?{prompt:u.input_tokens||0,completion:u.output_tokens||0,total:(u.input_tokens||0)+(u.output_tokens||0)}:undefined,elapsedMs:r.elapsedMs,headers:r.headers};}return{ok:false,error:r.error,elapsedMs:r.elapsedMs};}
  const mm:Record<string,string>={openai:"gpt-4.1-mini",deepseek:"deepseek-chat",openrouter:"openai/gpt-4.1-mini",xai:"grok-3-mini",groq:"llama-3.3-70b-versatile",together:"meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",mistral:"mistral-small-2506",perplexity:"sonar-reasoning",cohere:"command-r7b-12-2024",fireworks:"accounts/fireworks/models/llama-v3p3-70b-instruct",replicate:"meta/llama-3.3-70b-instruct",ollama:"llama3.2",siliconflow:"Qwen/Qwen3-8B",deepinfra:"meta-llama/Llama-4-Maverick-17B-128E-Instruct",huggingface:"Qwen/Qwen2.5-7B-Instruct",custom:"gpt-4.1-mini",nvidia:"nvidia/llama-3.1-nemotron-ultra-253b-v1",novita:"deepseek/deepseek-v3-0324",cerebras:"llama3.1-8b",azure:"gpt-4o-mini",vercel:"gpt-4o-mini"};
  const model=mm[provider]||"gpt-4o-mini";
  const hdrs:Record<string,string>={"content-type":"application/json"};
  if (info.authHeader) hdrs["Authorization"]=info.authHeader;
  if (provider==="cohere") delete hdrs["Authorization"];
  const r=await ap(info.chatUrl,hdrs,{model,messages:[{role:"user",content:q}],max_tokens:50,temperature:0},20000);
  if(r.ok){const d=r.data as Record<string,unknown>|undefined;const cs=d?.choices as Array<Record<string,unknown>>|undefined;const tx=String((cs?.[0]?.message as Record<string,unknown>|undefined)?.content||cs?.[0]?.text||"");const u=d?.usage as Record<string,number>|undefined;return{ok:true,text:tx.trim(),model:String(d?.model||model),usage:u?{prompt:u.prompt_tokens||0,completion:u.completion_tokens||0,total:u.total_tokens||0}:undefined,elapsedMs:r.elapsedMs,headers:r.headers};}return{ok:false,error:r.error,elapsedMs:r.elapsedMs};}

// ── Balance ──
async function cb(provider:string,key:string,baseUrl:string): Promise<string>{const info=dp(key,baseUrl);const hdrs:Record<string,string>={Authorization:`Bearer ${key}`,...(provider==="openrouter"?{"HTTP-Referer":"https://t.me/telebox_next"}:{})};const lines:string[]=[];
  if(provider==="openai"){
    // Subscription + usage + org info
    const sub=await ag(`${info.baseUrl}/v1/dashboard/billing/subscription`,hdrs,10000);
    if(sub.ok){const d=sub.data as Record<string,unknown>|undefined;const plan=(d?.plan as Record<string,unknown>|undefined)?.title||"?";const until=d?.access_until?new Date((d.access_until as number)*1000).toLocaleDateString("zh-CN"):"?";lines.push(`📋 套餐: ${plan} | 📅 至: ${until}`);lines.push(`💰 硬上限: $${d?.hard_limit_usd??"?"} | 软: $${d?.soft_limit_usd??"?"} | 系统: $${d?.system_hard_limit_usd??"?"}`);if(d?.has_payment_method!==undefined)lines.push(`💳 支付方式: ${d?.has_payment_method?"✅":"❌"}`);}else if(sub.status===401)return"❌ Key 无效";else lines.push("⚠️ 无 billing 权限（platform key 可能无法查账单）");
    const now=Math.floor(Date.now()/1000);
    const usg=await ag(`${info.baseUrl}/v1/dashboard/billing/usage?start_date=${now-90*86400}&end_date=${now}`,hdrs,10000);
    if(usg.ok){const d=usg.data as Record<string,unknown>|undefined;lines.push(`📊 近90天: $${(((d?.total_usage as number)||0)/100).toFixed(4)}`);}
    // Models endpoint → get owned_by + rate limits per model
    const mdls=await ag(`${info.baseUrl}/v1/models`,hdrs,10000);
    if(mdls.ok){const d=mdls.data as Record<string,unknown>|undefined;const arr=(Array.isArray(mdls.data)?mdls.data:d?.data as Array<Record<string,unknown>>)||[];const ownerSet=new Set<string>();let maxTier="";for(const m of arr.slice(0,50)){if(m.owned_by)ownerSet.add(String(m.owned_by));if(m.max_tier)maxTier=String(m.max_tier);}if(ownerSet.size)lines.push(`🏢 Org: ${[...ownerSet].slice(0,3).join(", ")}${ownerSet.size>3?" ...":""}`);if(maxTier)lines.push(`📈 Tier: ${maxTier}`);}
    if(sub.headers&&Object.keys(sub.headers).length)lines.push(fh(sub.headers));
    return lines.join("\n")||"✅ Key 有效";
  }
  if(provider==="openrouter"){
    const r=await ag(`${info.baseUrl}/api/v1/auth/key`,hdrs,10000);
    if(r.ok){const d=(r.data as Record<string,unknown>|undefined);const info=(d?.data||d)as Record<string,unknown>|undefined||{};lines.push(`🏷️ ${info.label||info.name||"?"}`);lines.push(`💰 余额: $${info.credits??"?"} | 📊 已用: $${info.usage??"?"}${info.limit!==undefined?` | 📏 限额: $${info.limit}`:""}`);if(info.rate_limit){const rl=info.rate_limit as Record<string,unknown>;lines.push(`⚡ 速率: ${rl.requests||"?"} req / ${rl.interval||"?"}`);}const disabled=(info.disabled_providers as Array<unknown>|undefined);if(disabled?.length)lines.push(`🚫 禁用: ${disabled.length} providers`);}else if(r.status===401)return"❌ Key 无效";else return`⚠️ ${r.error||"查询失败"}`;
    if(r.headers&&Object.keys(r.headers).length)lines.push(fh(r.headers));
    return lines.join("\n");
  }
  if(provider==="deepseek"){const r=await ag(`${info.baseUrl.replace(/\/v\d.*$/,"")}/user/balance`,hdrs,10000);if(r.ok){const d=r.data as Record<string,unknown>|undefined;lines.push(`✅ 可用: ${d?.is_available?"是":"否"}`);const infos=d?.balance_infos as Array<Record<string,unknown>>|undefined;if(infos)for(const bi of infos)lines.push(`💰 ${bi.currency||"余额"}: ${bi.total_balance||"?"} (已用: ${bi.topped_up_balance||"?"})`);}else if(r.status===401)return"❌ Key 无效";else return`⚠️ ${r.error||"查询失败"}`;return lines.join("\n");}
  if(provider==="anthropic"){const r=await ap("https://api.anthropic.com/v1/messages",{"x-api-key":key,"anthropic-version":"2023-06-01","content-type":"application/json"},{model:"claude-3.5-haiku-20241022",max_tokens:1,messages:[{role:"user",content:"hi"}]},15000);if(r.status===401||r.status===403)return"❌ Key 无效";if(r.ok||r.status===429)return`✅ Key 有效 (${r.status===429?"已限流":"正常"})\n⚠️ 余额请前往 console.anthropic.com 查看`;return`⚠️ HTTP ${r.status}: ${r.error||""}`;}
  if(provider==="gemini"){const r=await ag(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,{},10000);if(r.ok){const ms=(r.data as Record<string,unknown>|undefined)?.models as Array<unknown>|undefined;return`✅ Key 有效 | 📋 ${ms?.length??0} 个模型\n⚠️ 免费额度请在 Google Cloud Console 查看`;}if(r.status===400&&JSON.stringify(r.data||"").includes("API_KEY_INVALID"))return"❌ Key 无效";return`⚠️ HTTP ${r.status}: ${r.error||"可能有效"}`;}
  if(provider==="xai"){const r=await ag(`${info.baseUrl}/v1/models`,hdrs,10000);if(r.ok){const arr=Array.isArray(r.data)?r.data:(r.data as Record<string,unknown>|undefined)?.data as Array<unknown>|undefined;return`✅ Key 有效 | 📋 ${arr?.length??0} 个模型\n⚠️ 余额请前往 console.x.ai 查看`;}if(r.status===401)return"❌ Key 无效";return`⚠️ HTTP ${r.status}`;}

  if(provider==="nvidia"){const r=await ag(`${info.baseUrl}/v1/models`,hdrs,10000);if(r.ok){const arr=Array.isArray(r.data)?r.data:(r.data as Record<string,unknown>|undefined)?.data as Array<unknown>|undefined;return`✅ Key 有效 | 📋 ${arr?.length??0} 个模型\n⚠️ 余额请前往 build.nvidia.com 查看`;}if(r.status===401)return"❌ Key 无效";return`⚠️ HTTP ${r.status}`;}if(provider==="novita"){const r=await ag(`${info.baseUrl}/v1/models`,hdrs,10000);if(r.ok){const arr=Array.isArray(r.data)?r.data:(r.data as Record<string,unknown>|undefined)?.data as Array<unknown>|undefined;return`✅ Key 有效 | 📋 ${arr?.length??0} 个模型`;}if(r.status===401)return"❌ Key 无效";return`⚠️ HTTP ${r.status}`;}if(provider==="cerebras"){const r=await ag(`${info.baseUrl}/v1/models`,hdrs,10000);if(r.ok){const arr=Array.isArray(r.data)?r.data:(r.data as Record<string,unknown>|undefined)?.data as Array<unknown>|undefined;return`✅ Key 有效 | 📋 ${arr?.length??0} 个模型\n⚠️ 余额请前往 cloud.cerebras.ai 查看`;}if(r.status===401)return"❌ Key 无效";return`⚠️ HTTP ${r.status}`;} // Generic models endpoint test for unrecognized providers
  const testUrls = [`${info.baseUrl}/v1/models`, `${info.baseUrl}/models`];
  for (const u of testUrls) {
    const r = await ag(u, hdrs, 10000);
    if (r.ok) {
      const arr = Array.isArray(r.data) ? r.data : (r.data as Record<string,unknown>|undefined)?.data as Array<unknown>|undefined;
      const count = arr?.length ?? "?";
      const rateInfo = r.headers && Object.keys(r.headers).length ? `\n${fh(r.headers)}` : "";
      return `✅ 连接成功 | 📋 ${count} 个模型 | 🕐 ${r.elapsedMs||"?"}ms${rateInfo}`;
    }
    if (r.status === 401) return "❌ Key 无效";
    if (r.status === 404 || r.status === 405) continue;
    // Some endpoint worked (non-404) — likely valid
    return `✅ 服务可达 (HTTP ${r.status}) | 🕐 ${r.elapsedMs||"?"}ms\n⚠️ 无法查询模型列表`;
  }
  return `⚠️ 无法连接: 尝试了 models 端点均失败`;
}

// ── Model list ──
async function lmf(provider:string,key:string,baseUrl:string): Promise<string>{
  const info=dp(key,baseUrl);
  const hdrs:Record<string,string>=info.authHeader?{Authorization:info.authHeader}:{};
  const url=provider==="gemini"?`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`
    :provider==="ollama"?`${info.baseUrl}/api/tags`
    :info.modelsUrl||`${info.baseUrl}/v1/models`;

  const r=await ag(url,provider==="anthropic"?info.headers:hdrs,12000);
  if(!r.ok)return`❌ 获取模型失败: ${r.error}`;
  let models:Array<Record<string,unknown>>=[];
  if(provider==="gemini"){models=(r.data as Record<string,unknown>|undefined)?.models as Array<Record<string,unknown>>||[];}
  else if(provider==="ollama"){models=((r.data as Record<string,unknown>|undefined)?.models as Array<Record<string,unknown>>||[]).map((m:Record<string,unknown>)=>({id:String(m.name||"").replace(/:latest$/,""),owned_by:"ollama"}));}
  else{const d=r.data as Record<string,unknown>|undefined;models=(Array.isArray(r.data)?r.data:d?.data as Array<Record<string,unknown>>)||[];}
  if(!models.length)return"❌ 模型列表为空";

  const cats:Record<string,string[]>={};let total=0;
  for(const m of models){
    const name=String(m.id||m.name||"").replace("models/","").replace(":latest","");
    if(!name)continue;
    const owner=String(m.owned_by||"");
    let cat="其他";
    if(provider==="gemini"){cat=name.includes("gemini")?"Gemini":name.includes("embedding")?"Embedding":name.includes("imagen")?"Imagen":"其他";}
    else{if(/gpt|o1|o3|o4|o5/i.test(name))cat="GPT / o-series";else if(/claude/i.test(name))cat="Claude";else if(/gemini/i.test(name))cat="Gemini";else if(/deepseek/i.test(name))cat="DeepSeek";else if(/nemotron/i.test(name))cat="Nemotron";else if(/nvidia/i.test(name))cat="NVIDIA";else if(/grok/i.test(name))cat="Grok";else if(/llama|mistral|mixtral|qwen/i.test(name))cat="开源模型";else if(/embed|text-embed/i.test(name))cat="Embedding";else if(/dall-e|imagen|flux|stable|sdxl/i.test(name))cat="图像生成";else if(/tts|whisper|audio|speech/i.test(name))cat="语音";else if(/moderation/i.test(name))cat="审核";else if(/rerank|reranker/i.test(name))cat="Rerank";else if(owner)cat=owner.split("/")[0];}
    (cats[cat]||=[]).push(name);total++;
  }
  const lines:string[]=[`🤖 可用模型: ${total} 个`];
  const cn=Object.keys(cats).sort((a,b)=>(cats[b].length-cats[a].length)||a.localeCompare(b));
  for(const cat of cn){
    const ms=cats[cat];if(cn.length>1&&ms.length<3)continue;
    lines.push(`\n<b>${cat}</b> (${ms.length}):`);
    lines.push(`<blockquote expandable>${ms.slice(0,15).map(m=>`<code>${m}</code>`).join(" | ")}${ms.length>15?` | ... +${ms.length-15}`:""}</blockquote>`);
  }
  if(r.headers&&Object.keys(r.headers).length){lines.push(`\n⚡ 速率限制:`);for(const[k,v]of Object.entries(r.headers)){lines.push(`  <code>${k}</code>: ${v}`);}}
  return lines.join("\n");
}

// ── Full check ──
async function fcv2(provider:string,key:string,baseUrl:string): Promise<string[]>{
  const rs:string[]=[];const info=dp(key,baseUrl);
  rs.push(`🔍 <b>${info.displayName}</b> (${info.provider}, ${info.confidence})`);
  rs.push(`🔑 ${mk(key)}`);
  rs.push(`\n💰 <b>余额/状态</b>:`);
  try{rs.push(await cb(provider,key,baseUrl));}catch(e:unknown){rs.push(`⚠️ ${ge(e)}`);}
  rs.push(`\n💬 <b>对话测试</b>:`);
  try{const chat=await ct(provider,key,baseUrl);if(chat.ok){rs.push(`✅ 响应: "${chat.text}" (${chat.elapsedMs}ms) | 🤖 <code>${chat.model}</code>`);if(chat.usage)rs.push(`📊 Token: 入${chat.usage.prompt} 出${chat.usage.completion} 计${chat.usage.total}`);if(chat.headers)rs.push(fh(chat.headers));}else{rs.push(`❌ 失败: ${chat.error||"无响应"}`);}}catch(e:unknown){rs.push(`⚠️ ${ge(e)}`);}
  rs.push(`\n📋 <b>模型列表</b>:`);
  try{rs.push(await lmf(provider,key,baseUrl));}catch(e:unknown){rs.push(`⚠️ ${ge(e)}`);}
  return rs;
}

// ── Speed benchmark ──
async function speedTest(provider:string,key:string,baseUrl:string): Promise<string[]>{
  const models:Record<string,string[]>={openai:["gpt-4.1-mini","gpt-4.1-nano","gpt-4o-mini"],groq:["llama-3.3-70b-versatile","mixtral-8x7b-32768","gemma2-9b-it"],deepseek:["deepseek-chat","deepseek-reasoner"],openrouter:["openai/gpt-4.1-mini","anthropic/claude-3.5-haiku","google/gemini-2.5-flash"],together:["meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8","Qwen/Qwen3-235B-A22B"],fireworks:["accounts/fireworks/models/llama-v3p3-70b-instruct","accounts/fireworks/models/deepseek-v3"],mistral:["mistral-small-2506","codestral-2501"],xai:["grok-3-mini","grok-2-latest"],perplexity:["sonar-reasoning","sonar-pro"],siliconflow:["Qwen/Qwen3-8B","deepseek-ai/DeepSeek-V3"],deepinfra:["meta-llama/Llama-4-Maverick-17B-128E-Instruct"],nvidia:["nvidia/llama-3.1-nemotron-ultra-253b-v1"],novita:["deepseek/deepseek-v3-0324","meta-llama/Llama-3.3-70B-Instruct"],cerebras:["llama3.1-8b","llama3.3-70b"],azure:["gpt-4o-mini"],vercel:["gpt-4o-mini"]};
  const testModels=models[provider]||["gpt-4o-mini"];
  const info=dp(key,baseUrl);
  const hdrs:Record<string,string>={"content-type":"application/json"};
  if(info.authHeader)hdrs["Authorization"]=info.authHeader;

  const rs:string[]=[`⚡ <b>${info.displayName}</b> 速度基准 (say ok, 50 tokens max):`];
  for(const m of testModels){
    try{
      const start=Date.now();
      const r=await ap(info.chatUrl,hdrs,{model:m,messages:[{role:"user",content:"ok"}],max_tokens:50,temperature:0},30000);
      const elapsed=Date.now()-start;
      if(r.ok){const d=r.data as Record<string,unknown>|undefined;const tps=r.data?(((d?.usage as Record<string,number>|undefined)?.total_tokens||0)/(elapsed/1000)).toFixed(1):"?";rs.push(`  ✅ <code>${m}</code>: ${elapsed}ms (${tps} tok/s)`);}
      else rs.push(`  ❌ <code>${m}</code>: ${r.error?.slice(0,60)||"失败"}`);
    }catch(e:unknown){rs.push(`  ❌ <code>${m}</code>: ${ge(e).slice(0,60)}`);}
  }
  return rs;
}

// ── Plugin ──
class CheckApiPlugin extends Plugin{name="checkapi";description=
`🔍 API Key 全功能检测 v5\n\n支持 24+ Provider: OpenAI/Anthropic/Gemini/DeepSeek/OpenRouter/xAI/Groq/Together/Mistral/Perplexity/Fireworks/Replicate/Cohere/Ollama/HuggingFace/SiliconFlow/DeepInfra/NVIDIA/Novita/Cerebras/Azure/Vercel/自定义\n\n用法:\n<blockquote expandable><code>${mp}checkapi &lt;key&gt; [baseUrl]</code> — 一键全检\n<code>${mp}checkapi &lt;URL&gt; &lt;key&gt;</code> — URL 自动识别 API\n<code>${mp}checkapi ask &lt;k&gt; &lt;q&gt;</code> — 真实对话\n<code>${mp}checkapi models &lt;k&gt;</code> — 模型列表\n<code>${mp}checkapi speed &lt;k&gt;</code> — 速度基准测试\n<code>${mp}checkapi compare &lt;k1&gt; &lt;k2&gt;</code> — 多 Key 对比\n<code>${mp}checkapi save/list/del/check</code> — 管理</blockquote>\n支持智能输入: 直接粘贴 curl 命令 / ENV 变量 / JSON config\nURL 域名识别: api.groq.com→Groq | api.together.xyz→Together | api.mistral.ai→Mistral | integrate.api.nvidia.com→NVIDIA | api.novita.ai→Novita | api.cerebras.ai→Cerebras | *.openai.azure.com→Azure | gateway.ai.vercel.com→Vercel | ...`;

cmdHandlers:Record<string,(msg:Api.Message)=>Promise<void>>={checkapi:async(msg)=>{
  const raw=msg.message.slice(mp.length).trim();
  let text=raw;

  // ── Smart input parsing ──
  let extracedKey:string|undefined,extracedUrl:string|undefined;
  // Try curl command
  const curlParsed=parseCurl(raw);
  if(curlParsed){extracedKey=curlParsed.key;extracedUrl=curlParsed.url;text="";}
  // Try ENV var
  const envParsed=parseEnv(raw);
  if(!extracedKey&&envParsed){extracedKey=envParsed.key;text="";}
  // Try JSON config
  if(!extracedKey&&(raw.includes('"api_key"')||raw.includes('"apiKey"')||raw.includes('"key"'))){
    try{const j=JSON.parse(raw.replace(/^`+|`+$/g,""));extracedKey=j.api_key||j.apiKey||j.key||j.token;extracedUrl=j.base_url||j.baseUrl||j.endpoint;}catch{/* not JSON */}
  }

  const parts=text.split(/\s+/).filter(Boolean);
  if(extracedKey){parts.unshift(extracedKey);if(extracedUrl)parts.unshift(extracedUrl);}

  if(parts.length===0||parts[0]==="help"){await msg.edit({text:`${this.description}`, parseMode: "html" });return;}
  const sub=parts[0]?.toLowerCase();

  // ── list / del / save / check ──
  if(sub==="list"){const keys=await lk();if(!keys.length){await msg.edit({text:`📭 未保存\n<code>${mp}checkapi save &lt;name&gt; &lt;key&gt;</code>`, parseMode: "html" });return;}const lines=[`🔑 已保存 (${keys.length}):`];for(const k of keys)lines.push(`  • <b>${k.name}</b>: ${mk(k.key)} (${k.provider||"auto"})${k.baseUrl?` [${(()=>{try{return new URL(k.baseUrl).hostname}catch{return k.baseUrl}})()}]`:""}`);await msg.edit({text:`${lines.join("\n")}`, parseMode: "html" });return;}
  if(sub==="del"||sub==="delete"){const name=parts[1];if(!name){await msg.edit({text:`❌ <code>${mp}checkapi del &lt;name&gt;</code>`, parseMode: "html" });return;}const keys=await lk();const idx=keys.findIndex(k=>k.name===name);if(idx===-1){await msg.edit({text:`❌ 未找到 <b>${name}</b>`, parseMode: "html" });return;}keys.splice(idx,1);await sk(keys);await msg.edit({text:`✅ 已删除 <b>${name}</b>`, parseMode: "html" });return;}
  if(sub==="save"){let name:string|undefined,key:string|undefined,baseUrl:string|undefined;if(parts.length>=4&&isUrl(parts[2])){name=parts[1];baseUrl=nu(parts[2]);key=parts[3];}else{name=parts[1];key=parts[2];baseUrl=parts[3];}if(!name||!key){await msg.edit({text:`❌ <code>${mp}checkapi save &lt;name&gt; &lt;key|url&gt; &lt;key|url&gt;</code>\n示例: <code>${mp}checkapi save oai sk-xxx</code>`, parseMode: "html" });return;}const keys=await lk();const info=dp(key,baseUrl);const entry:SK={name,key,baseUrl,provider:info.provider,addedAt:Date.now()};const idx=keys.findIndex(k=>k.name===name);if(idx>=0)keys[idx]=entry;else keys.push(entry);await sk(keys);await msg.edit({text:`✅ ${idx>=0?"已更新":"已保存"} <b>${name}</b> (${info.displayName})\n<code>${mp}checkapi ${name}</code> 检测`, parseMode: "html" });return;}
  if(sub==="check"){const target=parts[1]||"all";if(target==="all"){const keys=await lk();if(!keys.length){await msg.edit({text:`📭 未保存`, parseMode: "html" });return;}await msg.edit({text:`🔍 检测 ${keys.length} 个...`, parseMode: "html" });const results:string[]=[];const promises=keys.map(async(k)=>{const info=dp(k.key,k.baseUrl);try{return[`\n━━━ <b>${k.name}</b> ━━━`,...(await fcv2(info.provider,k.key,k.baseUrl||info.baseUrl))]as string[]}catch(e:unknown){return[`\n━━━ <b>${k.name}</b> ━━━`,`⚠️ ${ge(e)}`]as string[]}});const batches=await Promise.all(promises);for(const row of batches)results.push(...row);await msg.edit({text:`${results.join("\n")}`, parseMode: "html" });return;}const keys=await lk();const found=keys.find(k=>k.name===target);if(!found){await msg.edit({text:`❌ 未找到 <b>${target}</b>`, parseMode: "html" });return;}await msg.edit({text:`🔍 <b>${target}</b>...`, parseMode: "html" });const info=dp(found.key,found.baseUrl);const results=await fcv2(info.provider,found.key,found.baseUrl||info.baseUrl);await msg.edit({text:`${results.join("\n")}`, parseMode: "html" });return;}

  // ── models / ask / speed ──
  if(sub==="models"){const input=parts[1];if(!input){await msg.edit({text:`❌ <code>${mp}checkapi models &lt;key|name&gt;</code>`, parseMode: "html" });return;}const keys=await lk();const found=keys.find(k=>k.name===input);const key=found?found.key:input;const info=dp(key,found?.baseUrl);await msg.edit({text:`🔍 ${info.displayName} 模型列表...`, parseMode: "html" });const result=await lmf(info.provider,key,info.baseUrl);await msg.edit({text:`${result}`, parseMode: "html" });return;}
  if(sub==="ask"){const input=parts[1];const question=parts.slice(2).join(" ");if(!input){await msg.edit({text:`❌ <code>${mp}checkapi ask &lt;key|name&gt; &lt;问题&gt;</code>`, parseMode: "html" });return;}const keys=await lk();const found=keys.find(k=>k.name===input);const key=found?found.key:input;const info=dp(key,found?.baseUrl);const prompt=question||"say hello";await msg.edit({text:`💬 ${info.displayName}: "${prompt}" ...`, parseMode: "html" });const chat=await ct(info.provider,key,info.baseUrl,prompt);if(chat.ok){const l=[`💬 <b>${info.displayName}</b>`,`🤖 <code>${chat.model}</code> | 🕐 ${chat.elapsedMs}ms`,`📝 ${chat.text}`];if(chat.usage)l.push(`📊 Tok: 入${chat.usage.prompt} 出${chat.usage.completion} 计${chat.usage.total}`);if(chat.headers)l.push(fh(chat.headers));await msg.edit({text:`${l.join("\n")}`, parseMode: "html" });}else{await msg.edit({text:`❌ (${chat.elapsedMs||"?"}ms): ${chat.error}`, parseMode: "html" });}return;}
  if(sub==="speed"){const input=parts[1];if(!input){await msg.edit({text:`❌ <code>${mp}checkapi speed &lt;key|name&gt;</code>`, parseMode: "html" });return;}const keys=await lk();const found=keys.find(k=>k.name===input);const key=found?found.key:input;const info=dp(key,found?.baseUrl);await msg.edit({text:`⚡ ${info.displayName} 基准测试中...`, parseMode: "html" });const results=await speedTest(info.provider,key,info.baseUrl);await msg.edit({text:`${results.join("\n")}`, parseMode: "html" });return;}

  // ── compare: two keys side by side ──
  if(sub==="compare"){const [a,b]=[parts[1],parts[2]];if(!a||!b){await msg.edit({text:`❌ <code>${mp}checkapi compare &lt;key1|name1&gt; &lt;key2|name2&gt;</code>`, parseMode: "html" });return;};const keys=await lk();const resolve=(input:string)=>{const f=keys.find(k=>k.name===input);return f?{key:f.key,baseUrl:f.baseUrl,label:f.name}:{key:input,baseUrl:undefined,label:mk(input)};};const r1=resolve(a),r2=resolve(b);const p1=dp(r1.key,r1.baseUrl),p2=dp(r2.key,r2.baseUrl);await msg.edit({text:`🔍 对比 <b>${r1.label}</b> vs <b>${r2.label}</b>...`, parseMode: "html" });const [s1,s2]=await Promise.all([fcv2(p1.provider,r1.key,p1.baseUrl),fcv2(p2.provider,r2.key,p2.baseUrl)]);const m=[`⚖️ <b>${p1.displayName}</b> (${r1.label})`,...s1,`\n━━━━━━━━━━━━━━━━`,...s2];await msg.edit({text:`${m.join("\n")}`, parseMode: "html" });return;}

  // ── Inline key: auto-detect + full check ──
  let key:string,baseUrl:string|undefined;let label:string;const keys=await lk();
  if(parts.length>=2&&isUrl(parts[0])){baseUrl=nu(parts[0]);key=parts[1];label=mk(key);}
  else if(parts.length>=2&&isUrl(parts[1])){key=parts[0];baseUrl=nu(parts[1]);const found=keys.find(k=>k.name===key);label=found?found.name:mk(key);key=found?found.key:key;}
  else{const input=parts[0];const found=keys.find(k=>k.name===input);key=found?found.key:input;baseUrl=found?.baseUrl;label=found?found.name:mk(key);}
  const info=dp(key,baseUrl);
  await msg.edit({text:`🔍 <b>${label}</b> (${info.displayName}) 全检中...`, parseMode: "html" });
  const results=await fcv2(info.provider,key,info.baseUrl);
  results.unshift(`🔍 <b>${label}</b>`);
  await msg.edit({text:`${results.join("\n")}`, parseMode: "html" });
},};}

export default new CheckApiPlugin();
