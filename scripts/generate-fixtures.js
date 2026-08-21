// Creates real PDF and video fixtures used to exercise the document reader
// and video player. Files land in data/fixtures/ (gitignored).

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const OUT = path.join(__dirname, '..', 'data', 'fixtures');
fs.mkdirSync(OUT, { recursive: true });

function pdfEscape(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function makePdf({ pages, title, extraLines = 0 }) {
  const kids = [];
  const objs = [];
  let nextId = 3;

  function add(body) {
    const id = nextId++;
    objs.push({ id, body });
    return id;
  }

  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  for (let i = 0; i < pages; i += 1) {
    const lines = [
      `BT /F1 22 Tf 56 760 Td (${pdfEscape(title)}) Tj ET`,
      `BT /F1 12 Tf 56 730 Td (Page ${i + 1} of ${pages} — StudyCore fixture) Tj ET`
    ];
    for (let n = 0; n < extraLines; n += 1) {
      const y = 700 - (n % 28) * 18;
      if (y < 60) break;
      lines.push(`BT /F1 10 Tf 56 ${y} Td (${pdfEscape(`Line ${n + 1}: vector calculus revision notes for university students.`)}) Tj ET`);
    }
    const stream = lines.join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
    kids.push(`${pageId} 0 R`);
  }

  const pagesObj = `2 0 obj << /Type /Pages /Kids [ ${kids.join(' ')} ] /Count ${pages} >> endobj\n`;
  const catalog = `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n`;
  let body = '%PDF-1.4\n';
  const offsets = [0];
  const write = (chunk) => {
    offsets.push(Buffer.byteLength(body));
    body += chunk;
  };
  write(catalog);
  write(pagesObj);
  for (const obj of objs) {
    write(`${obj.id} 0 obj ${obj.body} endobj\n`);
  }
  const xrefPos = Buffer.byteLength(body);
  const count = nextId;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  // offsets[0] unused; catalog is object 1
  const all = [catalog, pagesObj, ...objs.map((o) => `${o.id} 0 obj ${o.body} endobj\n`)];
  // Rebuild offsets accurately
  body = '%PDF-1.4\n';
  const pos = { 1: Buffer.byteLength(body) };
  body += catalog;
  pos[2] = Buffer.byteLength(body);
  body += pagesObj;
  for (const obj of objs) {
    pos[obj.id] = Buffer.byteLength(body);
    body += `${obj.id} 0 obj ${obj.body} endobj\n`;
  }
  const xrefStart = Buffer.byteLength(body);
  xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i += 1) {
    xref += `${String(pos[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += xref;
  body += `trailer << /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'StudyCore-fixture/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GET ${url} -> ${res.statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('download timeout'));
    });
  });
}

async function main() {
  const smallPdf = makePdf({ pages: 1, title: 'StudyCore Small Notes' });
  fs.writeFileSync(path.join(OUT, 'small.pdf'), smallPdf);

  const multiPdf = makePdf({ pages: 12, title: 'StudyCore Multi-page Tutorial', extraLines: 8 });
  fs.writeFileSync(path.join(OUT, 'multipage.pdf'), multiPdf);

  const largePdf = makePdf({ pages: 80, title: 'StudyCore Large Past Paper', extraLines: 24 });
  fs.writeFileSync(path.join(OUT, 'large.pdf'), largePdf);

  fs.writeFileSync(path.join(OUT, 'notes.txt'), 'StudyCore text fixture\nLine 2: integration by parts.\n');

  const videos = [
    { name: 'small.mp4', url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4' },
    { name: 'large.mp4', url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/friday.mp4' },
    { name: 'sample.webm', url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm' }
  ];

  for (const v of videos) {
    const dest = path.join(OUT, v.name);
    try {
      await download(v.url, dest);
      const size = fs.statSync(dest).size;
      if (size < 500) throw new Error('too small');
      console.log('downloaded', v.name, size);
    } catch (err) {
      console.warn('could not download', v.name, err.message);
    }
  }

  for (const file of fs.readdirSync(OUT)) {
    const st = fs.statSync(path.join(OUT, file));
    console.log(file, st.size);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
