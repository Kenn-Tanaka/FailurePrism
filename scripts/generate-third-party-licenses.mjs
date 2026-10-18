import fs from 'fs';
import path from 'path';

const rootDir = process.cwd();
const targetDir = path.join(rootDir, 'THIRD_PARTY_LICENSES');
const frontendTarget = path.join(targetDir, 'frontend');
const gatewayTarget = path.join(targetDir, 'gateway');

fs.mkdirSync(frontendTarget, { recursive: true });
fs.mkdirSync(gatewayTarget, { recursive: true });

const frontendPackages = [
  { name: 'react', file: 'react-LICENSE' },
  { name: 'react-dom', file: 'react-dom-LICENSE' },
  { name: '@xyflow/react', file: 'xyflow-react-LICENSE' },
  { name: '@xyflow/system', file: 'xyflow-system-LICENSE' },
  { name: 'lucide-react', file: 'lucide-react-LICENSE' },
  { name: 'zustand', file: 'zustand-LICENSE' },
  { name: 'zod', file: 'zod-LICENSE' },
  { name: 'react-markdown', file: 'react-markdown-license' },
  { name: 'clsx', file: 'clsx-license' },
  { name: 'tailwind-merge', file: 'tailwind-merge-LICENSE.md' },
  { name: 'tailwindcss', file: 'tailwindcss-LICENSE' },
  { name: 'pdfjs-dist', file: 'pdfjs-dist-LICENSE' },
  { name: 'mammoth', file: 'mammoth-LICENSE' },
  { name: 'xlsx', file: 'xlsx-LICENSE' },
];

console.log('Copying Frontend third-party licenses...');
for (const item of frontendPackages) {
  const pkgDir = path.join(rootDir, 'node_modules', ...item.name.split('/'));
  if (!fs.existsSync(pkgDir)) {
    console.warn(`Warning: Package directory ${pkgDir} not found`);
    continue;
  }
  const files = fs.readdirSync(pkgDir);
  const licenseFile = files.find(f => /^(licen[cs]e|copying)(\..+)?$/i.test(f));
  if (licenseFile) {
    const srcPath = path.join(pkgDir, licenseFile);
    const destPath = path.join(frontendTarget, item.file);
    fs.copyFileSync(srcPath, destPath);
    console.log(`  ✓ ${item.name} (${licenseFile}) -> frontend/${item.file}`);
  } else {
    console.warn(`Warning: No license file found for ${item.name}`);
  }
}

console.log('Copying Gateway third-party licenses...');
const gatewaySrc = path.join(rootDir, 'gateway', 'THIRD_PARTY_LICENSES');
if (fs.existsSync(gatewaySrc)) {
  const gwFiles = fs.readdirSync(gatewaySrc);
  for (const f of gwFiles) {
    fs.copyFileSync(path.join(gatewaySrc, f), path.join(gatewayTarget, f));
    console.log(`  ✓ gateway/${f} -> gateway/${f}`);
  }
}

// Generate index README
const indexContent = `# Third-Party Licenses (FailurePrism)

This directory contains the full text licenses for third-party open source software used by FailurePrism:

## 1. Web Frontend Packages (\`THIRD_PARTY_LICENSES/frontend/\`)
${frontendPackages.map(p => `- [${p.name}](./frontend/${p.file})`).join('\n')}

## 2. LLM-Gateway C++ Backend Packages (\`THIRD_PARTY_LICENSES/gateway/\`)
- [libcurl](./gateway/curl-COPYING)
- [cpp-httplib](./gateway/httplib-LICENSE)
- [llama.cpp (ggml)](./gateway/llama-LICENSE)
- [nlohmann/json](./gateway/nlohmann_json-LICENSE.MIT)
- [wxWidgets](./gateway/wxwidgets-licence.txt)
- [wxWidgets libpng](./gateway/wxwidgets-libpng-LICENSE)
- [wxWidgets PCRE](./gateway/wxwidgets-pcre-LICENCE)
- [wxWidgets zlib](./gateway/wxwidgets-zlib-LICENSE)

See \`NOTICE.md\` in the project root for package descriptions, versions, and usage notes.
`;

fs.writeFileSync(path.join(targetDir, 'README.md'), indexContent, 'utf-8');
console.log('Done generating THIRD_PARTY_LICENSES!');
