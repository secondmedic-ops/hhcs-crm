// Test PDF Builder
function createPdf() {
  const pages = [];
  let currentPageStream = [];

  function addPage() {
    currentPageStream = [];
    pages.push(currentPageStream);
  }

  addPage();

  // Draw header
  currentPageStream.push(`
0.12 0.16 0.24 rg
BT /F2 16 Tf 45 780 Td (HINDUJA HOME CARE SERVICES) Tj ET
0.40 0.45 0.53 rg
BT /F1 9 Tf 45 766 Td (In association with SecondMedic - P. D. Hinduja National Hospital & Medical Research Centre) Tj ET
0.85 0.88 0.92 RG 1 w
45 754 m 550 754 l S
0.12 0.16 0.24 rg
BT /F2 13 Tf 45 734 Td (QUOTATION / ESTIMATE) Tj ET
BT /F2 10 Tf 45 710 Td (Quotation No:) Tj ET
BT /F1 10 Tf 120 710 Td (HHC-261015-00001) Tj ET
BT /F2 10 Tf 45 696 Td (Date:) Tj ET
BT /F1 10 Tf 120 696 Td (15 Oct 2026) Tj ET
BT /F2 10 Tf 300 710 Td (Patient Name:) Tj ET
BT /F1 10 Tf 375 710 Td (Ramesh Sharma) Tj ET
BT /F2 10 Tf 300 696 Td (Contact Mobile:) Tj ET
BT /F1 10 Tf 375 696 Td (+91 98200 12012) Tj ET
`);

  // Build PDF document objects
  const objects = [];
  function addObject(content) {
    objects.push(content);
    return objects.length;
  }

  // 1: Catalog
  // 2: Pages tree
  // 3: Font Helvetica
  // 4: Font Helvetica-Bold
  // 5: Font Helvetica-Oblique
  // 6+: Page objects and Streams

  const catalogId = 1;
  const pagesTreeId = 2;
  const fontRegularId = 3;
  const fontBoldId = 4;
  const fontObliqueId = 5;

  const pageObjectIds = [];
  const streamObjectIds = [];

  let nextId = 6;
  for (let i = 0; i < pages.length; i++) {
    pageObjectIds.push(nextId++);
    streamObjectIds.push(nextId++);
  }

  // Header
  let out = '%PDF-1.4\n';

  // Catalog
  const objOffsets = [];
  
  function writeObj(id, body) {
    objOffsets[id] = out.length;
    out += `${id} 0 obj\n${body}\nendobj\n`;
  }

  writeObj(catalogId, `<< /Type /Catalog /Pages ${pagesTreeId} 0 R >>`);
  writeObj(pagesTreeId, `<< /Type /Pages /Kids [${pageObjectIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  writeObj(fontRegularId, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
  writeObj(fontBoldId, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`);
  writeObj(fontObliqueId, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>`);

  for (let i = 0; i < pages.length; i++) {
    const pageId = pageObjectIds[i];
    const streamId = streamObjectIds[i];
    const streamContent = pages[i].join('\n');
    const streamBytes = Buffer.from(streamContent, 'utf-8');

    writeObj(pageId, `<< /Type /Page /Parent ${pagesTreeId} 0 R /MediaBox [0 0 595.28 841.89] /Contents ${streamId} 0 R /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R /F3 ${fontObliqueId} 0 R >> >> >>`);
    writeObj(streamId, `<< /Length ${streamBytes.length} >>\nstream\n${streamContent}\nendstream`);
  }

  const startXref = out.length;
  out += `xref\n0 ${objects.length + 1 + pageObjectIds.length * 2}\n`;
  out += '0000000000 65535 f \n';
  for (let i = 1; i <= 5 + pageObjectIds.length * 2; i++) {
    out += String(objOffsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  out += `trailer\n<< /Size ${6 + pageObjectIds.length * 2} /Root ${catalogId} 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;

  return Buffer.from(out, 'utf-8');
}

const pdfBuf = createPdf();
console.log('PDF Generated successfully, size in bytes:', pdfBuf.length);
console.log('Starts with:', pdfBuf.slice(0, 15).toString());
console.log('Ends with:', pdfBuf.slice(-30).toString());

