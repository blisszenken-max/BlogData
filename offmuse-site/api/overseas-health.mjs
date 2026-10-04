import { publicManifestSummary } from '../gateway/core.mjs';

export default function handler(req,res) {
  return res.status(200).json({
    ok:true,
    service:'overseas-trend-gateway',
    mode:'vercel-hobby-merkle-r2',
    secret_configured:!!process.env.GATEWAY_SECRET,
    ...publicManifestSummary()
  });
}
