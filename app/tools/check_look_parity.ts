// Checks that ui/src/look.ts (live preview) and crates/md1-core/src/adjust.rs (export) produce
// the same pixels for colour + denoise. Run from app/:
//   cargo run -q -p md1-core --example look_vector > /tmp/look.rgb
//   node --experimental-strip-types tools/check_look_parity.ts /tmp/look.rgb
import { readFileSync } from "node:fs";
import { applyColor, denoise, type Adjust } from "../ui/src/look.ts";

const W = 96, H = 72;
const rgba = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const n = (x * 37 + y * 91 + x * y) % 23;
    const i = (y * W + x) * 4;
    rgba.set([x * 2 + n, y * 3 + n, x + y + 40 + n, 255], i);
  }
const a: Adjust = { auto: { lo: [0.02, 0.04, 0.1], hi: [0.8, 0.85, 0.9], gamma: 0.85 }, brightness: 0.3, contrast: 0.2, warmth: -0.4, saturation: 0.35, denoise: 0.6 };
const out = denoise(rgba, W, H, a.denoise);
applyColor(out, a);
const rust = readFileSync(process.argv[2]);
let max = 0, diff = 0;
for (let p = 0; p < W * H; p++)
  for (let c = 0; c < 3; c++) {
    const d = Math.abs(out[p * 4 + c] - rust[p * 3 + c]);
    max = Math.max(max, d);
    if (d) diff++;
  }
console.log(`max difference ${max}, ${diff} of ${W * H * 3} values differ`);
process.exit(max <= 1 ? 0 : 1);
