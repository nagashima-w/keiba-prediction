import { classifyHorseLegStyleFull } from "../../packages/core/src/analyzer/leg-style.ts";
import fs from "fs";
const cases = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
console.log(JSON.stringify(cases.map(c => classifyHorseLegStyleFull(c.map(([p,f])=>({passing:p,fieldSize:f}))))));
