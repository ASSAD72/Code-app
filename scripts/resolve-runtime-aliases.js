const fs = require('fs');
const path = require('path');
const dist = path.resolve(__dirname, '..', 'dist');
const aliases = {
  '@core/': './core/', '@sandbox/': './sandbox/', '@environments/': './environments/',
  '@intelligence/': './intelligence/', '@export/': './export/', '@storage/': './storage/',
  '@plugins/': './plugins/', '@tools/': './tools/', '@policy/': './policy/'
};
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) walk(file);
    else if (file.endsWith('.js') || file.endsWith('.d.ts')) rewrite(file);
  }
}
function rewrite(file) {
  let text = fs.readFileSync(file, 'utf8');
  const fromDir = path.dirname(file);
  for (const [alias, targetRoot] of Object.entries(aliases)) {
    const re = new RegExp(`(['\\"])${alias.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}([^'\\"]+)(['\\"])`, 'g');
    text = text.replace(re, (_, open, rest, close) => {
      const target = path.join(dist, targetRoot.slice(2), rest);
      let rel = path.relative(fromDir, target).replace(/\\/g, '/');
      if (!rel.startsWith('.')) rel = './' + rel;
      return open + rel + close;
    });
  }
  fs.writeFileSync(file, text);
}
walk(dist);
