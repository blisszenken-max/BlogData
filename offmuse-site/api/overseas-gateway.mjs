import { handleGateway } from '../gateway/core.mjs';

export default function handler(req,res) {
  if (req.method !== 'POST') return res.status(405).json({ok:false,error:'METHOD_NOT_ALLOWED'});
  try {
    const result = handleGateway(req.body || {}, process.env.GATEWAY_SECRET || '');
    return res.status(200).json(result);
  } catch (e) {
    return res.status(400).json({ok:false,error:String(e?.message || e)});
  }
}
