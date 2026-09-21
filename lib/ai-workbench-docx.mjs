/** Dependency-free OOXML export: text, headings, bold, lists and simple tables.
 * Images/formulas remain textual; no macros, external relationships or embedded files. */
const enc = new TextEncoder();
const xml = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
function crc32(bytes) { let crc = 0xffffffff; for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function zip(files) {
  const local = [], directory = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const n = enc.encode(name), data = enc.encode(value), crc = crc32(data);
    const h = new Uint8Array(30 + n.length), d = new DataView(h.buffer);
    d.setUint32(0, 0x04034b50, true); d.setUint16(4, 20, true); d.setUint16(6, 0x800, true); d.setUint16(12, 33, true);
    d.setUint32(14, crc, true); d.setUint32(18, data.length, true); d.setUint32(22, data.length, true); d.setUint16(26, n.length, true); h.set(n, 30);
    const c = new Uint8Array(46 + n.length), cd = new DataView(c.buffer);
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x800, true); cd.setUint16(14, 33, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true); cd.setUint16(28, n.length, true); cd.setUint32(42, offset, true); c.set(n, 46);
    local.push(h, data); directory.push(c); offset += h.length + data.length;
  }
  const end = new Uint8Array(22), ed = new DataView(end.buffer), count = directory.length;
  ed.setUint32(0, 0x06054b50, true); ed.setUint16(8, count, true); ed.setUint16(10, count, true); ed.setUint32(12, directory.reduce((n, b) => n + b.length, 0), true); ed.setUint32(16, offset, true);
  const parts = [...local, ...directory, end], out = new Uint8Array(parts.reduce((n,b) => n + b.length, 0)); let p = 0;
  for (const b of parts) { out.set(b, p); p += b.length; } return out;
}
function runs(value) { return value.split(/(\*\*[^*]+\*\*)/u).filter(Boolean).map(v => `<w:r>${v.startsWith('**') ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${xml(v.startsWith('**') ? v.slice(2, -2) : v)}</w:t></w:r>`).join(''); }
function paragraph(line) {
  const h = /^(#{1,3})\s+(.+)$/u.exec(line); const content = h ? h[2] : line.replace(/^\s*[-*]\s+/u, '• ');
  return `<w:p><w:pPr>${h ? `<w:pStyle w:val="Heading${h[1].length}"/><w:keepNext/>` : ''}<w:spacing w:after="140" w:line="320" w:lineRule="auto"/></w:pPr>${runs(content)}</w:p>`;
}
function body(markdown) {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n'); const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|.*\|\s*$/u.test(lines[i]) && /^\s*\|[ :|-]+\|\s*$/u.test(lines[i + 1] || '')) {
      const table = [lines[i]]; i += 2; while (i < lines.length && /^\s*\|.*\|\s*$/u.test(lines[i])) table.push(lines[i++]); i--;
      const rows = table.map(line => line.trim().slice(1, -1).split('|').map(cell => cell.trim()));
      const cols = Math.max(...rows.map(row => row.length));
      out.push(`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${['top','left','bottom','right','insideH','insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:color="B9C7D0"/>`).join('')}</w:tblBorders><w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${Array.from({length:cols}, () => `<w:gridCol w:w="${Math.floor(9026 / cols)}"/>`).join('')}</w:tblGrid>${rows.map((cells, index) => `<w:tr><w:trPr>${index ? '' : '<w:tblHeader/>'}<w:cantSplit/></w:trPr>${Array.from({length:cols}, (_, k) => `<w:tc><w:tcPr><w:tcW w:w="${Math.floor(9026 / cols)}" w:type="dxa"/>${index ? '' : '<w:shd w:fill="EDF2F5"/>'}</w:tcPr>${paragraph(cells[k] || '')}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`);
    } else out.push(paragraph(lines[i]));
  }
  return out.join('');
}
export function taskDocx(title, markdown) {
  if (markdown.trimStart().split('\n')[0].trim() === '# ' + title.trim()) markdown = markdown.trimStart().split('\n').slice(1).join('\n').trimStart();
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${ns}"><w:body>${paragraph('# ' + title)}${body(markdown)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${ns}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/><w:lang w:val="zh-CN"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${[1,2,3].map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="${n-1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${[36,28,24][n-1]}"/></w:rPr></w:style>`).join('')}</w:styles>`;
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': doc, 'word/styles.xml': styles,
    'word/_rels/document.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  });
}
