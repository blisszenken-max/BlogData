import { publicManifestSummary } from '../gateway-r3-lite/core.mjs';

export default function handler(req,res) {
  return res.status(200).json({
    ok:true,
    service:'overseas-trend-gateway',
    mode:'r3-lite-phase-control',
    ...publicManifestSummary(process.env)
  });
}
