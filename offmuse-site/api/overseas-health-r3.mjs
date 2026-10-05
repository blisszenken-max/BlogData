import { publicManifestSummary } from '../gateway-r3/core.mjs';

export default function handler(req,res) {
  return res.status(200).json({ok:true,service:'overseas-trend-gateway-r3',mode:'vercel-hobby-authoritative-r3',...publicManifestSummary(process.env)});
}
