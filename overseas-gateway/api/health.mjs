import { publicManifestSummary } from '../lib/core.mjs';
export default function handler(req,res) {
  return res.status(200).json({ok:true,service:'overseas-trend-gateway',mode:'hobby-stateless',...publicManifestSummary()});
}