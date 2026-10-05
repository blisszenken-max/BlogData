import { handleGateway } from '../gateway-r3/core.mjs';

export default async function handler(req,res) {
  if (req.method !== 'POST') return res.status(405).json({ok:false,error:'METHOD_NOT_ALLOWED'});
  const len=Number(req.headers['content-length']||0);
  if (len>1500000) return res.status(413).json({ok:false,error:'REQUEST_TOO_LARGE'});
  try {
    const result=await handleGateway(req.body||{},process.env);
    return res.status(200).json(result);
  } catch(e) {
    return res.status(400).json({ok:false,error:String(e?.message||e)});
  }
}
