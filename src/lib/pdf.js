// Pure JavaScript client-side PDF 1.4 generator for CareDesk quotations
// Standards-compliant, dependency-free, supports multi-page layouts, word-wrapping and exact rate-card snapshots.

// Character widths for Helvetica (per 1000 units)
const HELVETICA_WIDTHS = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, '\'': 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
  '@': 1015, 'A': 667, 'B': 667, 'C': 722, 'D': 722, 'E': 667, 'F': 611, 'G': 778,
  'H': 722, 'I': 278, 'J': 500, 'K': 667, 'L': 556, 'M': 833, 'N': 722, 'O': 778,
  'P': 667, 'Q': 778, 'R': 722, 'S': 667, 'T': 611, 'U': 722, 'V': 667, 'W': 944,
  'X': 667, 'Y': 667, 'Z': 611, '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556,
  '`': 333, 'a': 556, 'b': 556, 'c': 500, 'd': 556, 'e': 556, 'f': 278, 'g': 556,
  'h': 556, 'i': 222, 'j': 222, 'k': 500, 'l': 222, 'm': 833, 'n': 556, 'o': 556,
  'p': 556, 'q': 556, 'r': 333, 's': 500, 't': 278, 'u': 556, 'v': 500, 'w': 722,
  'x': 500, 'y': 500, 'z': 500, '{': 334, '|': 260, '}': 334, '~': 584,
};

function textWidth(str, fontSize, isBold = false) {
  let w = 0;
  const factor = isBold ? 1.08 : 1.0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    w += ((HELVETICA_WIDTHS[ch] || 550) * factor * fontSize) / 1000;
  }
  return w;
}

function sanitizeText(str) {
  if (str == null) return '';
  return String(str)
    .replace(/\r\n/g, '\n')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2022/g, '*')
    .replace(/\u20B9/g, 'Rs. ')
    .replace(/[^\x20-\x7E\n]/g, ' ');
}

function escapePdf(str) {
  return sanitizeText(str)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrapLines(text, maxWidth, fontSize, isBold = false) {
  const clean = sanitizeText(text);
  const words = clean.split(/\s+/);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    if (!word) continue;
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (textWidth(testLine, fontSize, isBold) <= maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.length ? lines : ['–'];
}

// Print the 15-day quotation validity on the PDF. Off until Dindayal confirms the rule;
// workspaces.settings.show_validity_on_pdf = true turns it back on without a release.
export const SHOW_VALIDITY_ON_PDF = false;

export function formatInr(num) {
  if (num == null || isNaN(num)) return 'Rs. 0.00';
  const n = Number(num);
  const formatted = n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `Rs. ${formatted}`;
}

export function generateQuotationPdfBytes({ k, patient, items = [], workspace = null }) {
  const activeItems = (items || []).filter((it) => !it.excluded);
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const marginX = 40;
  const contentWidth = pageWidth - marginX * 2; // 515.28
  const showValidity = workspace?.settings?.show_validity_on_pdf ?? SHOW_VALIDITY_ON_PDF;

  const brandName = workspace?.brand_name || 'HINDUJA HOME CARE SERVICES';
  const brandSub = 'In association with SecondMedic · P. D. Hinduja National Hospital & Medical Research Centre';
  const brandMeta = 'Veer Savarkar Marg, Mahim, Mumbai - 400016 · Helpline: +91 80493 68621 · care@hindujahomecare.com';

  const caseNo = k?.case_no || '–';
  const quoteDate = k?.created_at ? new Date(k.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : new Date().toLocaleDateString('en-IN');
  const patientName = k?.patient_name || patient?.full_name || '–';
  const patientAgeGender = [k?.patient_age || patient?.age, k?.patient_gender || patient?.gender].filter(Boolean).join(' / ') || '–';
  const patientMobile = k?.patient_mobile || patient?.mobile || k?.caller_mobile_display || '–';
  const addressParts = [
    k?.address || patient?.address,
    k?.landmark || patient?.landmark,
    k?.patient_locality || patient?.locality,
    k?.pincode || patient?.pincode ? `PIN ${k?.pincode || patient?.pincode}` : null,
  ].filter(Boolean);
  const patientAddress = addressParts.join(', ') || '–';

  // Subtotal & discount from case snapshot
  const subtotal = Number(k?.subtotal ?? activeItems.reduce((acc, it) => acc + Number(it.line_total || it.unit_price * (it.qty || 1)), 0));
  const discountAmount = Number(k?.discount_amount ?? 0);
  const discountPct = Number(k?.discount_pct ?? 0);
  const total = Number(k?.total ?? (subtotal - discountAmount));

  // Columns: # (24), Description (240), Unit (65), Qty (35), Rate (70), Total (81)
  const cols = [
    { id: 'idx', label: '#', x: marginX, w: 24, align: 'center' },
    { id: 'desc', label: 'Service / Test Description', x: marginX + 24, w: 240, align: 'left' },
    { id: 'unit', label: 'Unit', x: marginX + 264, w: 65, align: 'left' },
    { id: 'qty', label: 'Qty', x: marginX + 329, w: 35, align: 'center' },
    { id: 'rate', label: 'Rate', x: marginX + 364, w: 70, align: 'right' },
    { id: 'total', label: 'Total Amount', x: marginX + 434, w: 81, align: 'right' },
  ];

  const pages = [];
  let curStream = [];
  let curY = pageHeight - 40;

  function newPage() {
    curStream = [];
    pages.push(curStream);
    curY = pageHeight - 40;
    renderPageHeader();
  }

  function renderPageHeader() {
    // Brand header
    curStream.push(`
0.12 0.16 0.24 rg
BT /F2 15 Tf ${marginX} ${curY} Td (${escapePdf(brandName)}) Tj ET
0.35 0.40 0.50 rg
BT /F1 8.5 Tf ${marginX} ${curY - 14} Td (${escapePdf(brandSub)}) Tj ET
0.50 0.55 0.65 rg
BT /F1 7.5 Tf ${marginX} ${curY - 26} Td (${escapePdf(brandMeta)}) Tj ET
0.82 0.85 0.90 RG 0.75 w
${marginX} ${curY - 34} m ${marginX + contentWidth} ${curY - 34} l S
`);
    curY -= 48;
  }

  function renderQuotationMeta() {
    curStream.push(`
0.12 0.16 0.24 rg
BT /F2 13 Tf ${marginX} ${curY} Td (SERVICE QUOTATION) Tj ET
0.40 0.45 0.53 rg
BT /F1 9 Tf ${marginX + 170} ${curY} Td (Approved Rate Card Estimate) Tj ET
`);
    curY -= 16;

    // 2-column info cards
    const boxY = curY;
    const boxH = 68;
    const colW = (contentWidth - 12) / 2;

    // Left card: Quotation meta
    curStream.push(`
0.96 0.97 0.98 rg 0.88 0.90 0.93 RG 0.5 w
${marginX} ${boxY - boxH} ${colW} ${boxH} re B
0.20 0.25 0.35 rg
BT /F2 8.5 Tf ${marginX + 8} ${boxY - 14} Td (QUOTATION DETAILS) Tj ET
BT /F2 8 Tf ${marginX + 8} ${boxY - 28} Td (Quotation Ref:) Tj ET
0.10 0.12 0.18 rg
BT /F1 8 Tf ${marginX + 80} ${boxY - 28} Td (${escapePdf(caseNo)}) Tj ET
0.20 0.25 0.35 rg
BT /F2 8 Tf ${marginX + 8} ${boxY - 42} Td (Date of Issue:) Tj ET
0.10 0.12 0.18 rg
BT /F1 8 Tf ${marginX + 80} ${boxY - 42} Td (${escapePdf(quoteDate)}) Tj ET
0.20 0.25 0.35 rg
BT /F2 8 Tf ${marginX + 8} ${boxY - 56} Td (Price Status:) Tj ET
0.10 0.12 0.18 rg
BT /F1 8 Tf ${marginX + 80} ${boxY - 56} Td (${showValidity ? 'Rate card locked · Valid 15 days' : 'Rate card locked'}) Tj ET
`);

    // Right card: Patient details
    const rightX = marginX + colW + 12;
    const addrLines = wrapLines(patientAddress, colW - 75, 7.5);
    curStream.push(`
0.96 0.97 0.98 rg 0.88 0.90 0.93 RG 0.5 w
${rightX} ${boxY - boxH} ${colW} ${boxH} re B
0.20 0.25 0.35 rg
BT /F2 8.5 Tf ${rightX + 8} ${boxY - 14} Td (PATIENT DETAILS) Tj ET
BT /F2 8 Tf ${rightX + 8} ${boxY - 28} Td (Patient Name:) Tj ET
0.10 0.12 0.18 rg
BT /F1 8 Tf ${rightX + 75} ${boxY - 28} Td (${escapePdf(patientName)}  (${escapePdf(patientAgeGender)})) Tj ET
0.20 0.25 0.35 rg
BT /F2 8 Tf ${rightX + 8} ${boxY - 42} Td (Contact Mobile:) Tj ET
0.10 0.12 0.18 rg
BT /F1 8 Tf ${rightX + 75} ${boxY - 42} Td (${escapePdf(patientMobile)}) Tj ET
0.20 0.25 0.35 rg
BT /F2 8 Tf ${rightX + 8} ${boxY - 56} Td (Service Area:) Tj ET
0.10 0.12 0.18 rg
BT /F1 7.5 Tf ${rightX + 75} ${boxY - 56} Td (${escapePdf(addrLines[0] || '–')}) Tj ET
`);

    curY -= (boxH + 16);
  }

  function renderTableHead() {
    curStream.push(`
0.20 0.25 0.35 rg 0.20 0.25 0.35 RG 0.5 w
${marginX} ${curY - 18} ${contentWidth} 18 re B
1 1 1 rg
`);
    for (const c of cols) {
      const textX = c.align === 'center' ? c.x + c.w / 2 : c.align === 'right' ? c.x + c.w - 6 : c.x + 6;
      const tw = textWidth(c.label, 8, true);
      const posX = c.align === 'center' ? textX - tw / 2 : c.align === 'right' ? textX - tw : textX;
      curStream.push(`BT /F2 8 Tf ${posX.toFixed(1)} ${(curY - 12).toFixed(1)} Td (${escapePdf(c.label)}) Tj ET`);
    }
    curY -= 18;
  }

  // Initial page
  newPage();
  renderQuotationMeta();
  renderTableHead();

  // Render Items
  if (!activeItems.length) {
    curStream.push(`
0.50 0.55 0.65 rg
BT /F3 9 Tf ${marginX + 20} ${curY - 20} Td (No services selected for this enquiry.) Tj ET
`);
    curY -= 30;
  } else {
    for (let i = 0; i < activeItems.length; i++) {
      const it = activeItems[i];
      const desc = it.service_name || it.service_code || 'Service';
      const descLines = wrapLines(desc, cols[1].w - 12, 8.5);
      const unit = it.unit || it.category || 'per service';
      const qty = String(it.qty || 1);
      const rate = formatInr(it.unit_price);
      const lineTot = formatInr(it.line_total || (Number(it.unit_price) * (it.qty || 1)));

      const rowHeight = Math.max(22, descLines.length * 11 + 8);

      // Check for page break
      if (curY - rowHeight < 120) {
        newPage();
        renderTableHead();
      }

      // Zebra striping
      if (i % 2 === 1) {
        curStream.push(`0.98 0.98 0.99 rg ${marginX} ${(curY - rowHeight).toFixed(1)} ${contentWidth} ${rowHeight} re f`);
      }
      // Row bottom border
      curStream.push(`0.90 0.92 0.94 RG 0.5 w ${marginX} ${(curY - rowHeight).toFixed(1)} m ${(marginX + contentWidth).toFixed(1)} ${(curY - rowHeight).toFixed(1)} l S`);

      // Draw index
      curStream.push(`0.30 0.35 0.45 rg BT /F1 8.5 Tf ${(cols[0].x + cols[0].w / 2 - 3).toFixed(1)} ${(curY - 14).toFixed(1)} Td (${i + 1}) Tj ET`);

      // Draw description lines
      curStream.push(`0.10 0.12 0.18 rg`);
      let textY = curY - 14;
      for (const line of descLines) {
        curStream.push(`BT /F2 8.5 Tf ${(cols[1].x + 6).toFixed(1)} ${textY.toFixed(1)} Td (${escapePdf(line)}) Tj ET`);
        textY -= 10;
      }
      if (it.price_tax_basis) {
        const taxNote = it.price_tax_basis === 'incl_gst' ? 'Incl. GST' : it.price_tax_basis === 'excl_gst' ? 'Excl. GST' : '';
        if (taxNote) {
          curStream.push(`0.50 0.55 0.65 rg BT /F3 7 Tf ${(cols[1].x + 6).toFixed(1)} ${textY.toFixed(1)} Td (${taxNote}) Tj ET`);
        }
      }

      // Draw unit
      curStream.push(`0.30 0.35 0.45 rg BT /F1 8 Tf ${(cols[2].x + 4).toFixed(1)} ${(curY - 14).toFixed(1)} Td (${escapePdf(unit)}) Tj ET`);

      // Draw Qty
      curStream.push(`0.20 0.25 0.35 rg BT /F1 8.5 Tf ${(cols[3].x + cols[3].w / 2 - 4).toFixed(1)} ${(curY - 14).toFixed(1)} Td (${escapePdf(qty)}) Tj ET`);

      // Draw Rate
      const rw = textWidth(rate, 8.5);
      curStream.push(`0.20 0.25 0.35 rg BT /F1 8.5 Tf ${(cols[4].x + cols[4].w - 6 - rw).toFixed(1)} ${(curY - 14).toFixed(1)} Td (${escapePdf(rate)}) Tj ET`);

      // Draw Line Total
      const tw = textWidth(lineTot, 8.5, true);
      curStream.push(`0.10 0.12 0.18 rg BT /F2 8.5 Tf ${(cols[5].x + cols[5].w - 6 - tw).toFixed(1)} ${(curY - 14).toFixed(1)} Td (${escapePdf(lineTot)}) Tj ET`);

      curY -= rowHeight;
    }
  }

  // Totals Section
  if (curY < 130) {
    newPage();
  }

  curY -= 10;
  const totW = 210;
  const totX = marginX + contentWidth - totW;
  const subFormatted = formatInr(subtotal);
  const totFormatted = formatInr(total);

  curStream.push(`
0.96 0.97 0.98 rg 0.85 0.88 0.92 RG 0.5 w
${totX} ${curY - 62} ${totW} 62 re B
0.25 0.30 0.40 rg
BT /F2 8.5 Tf ${totX + 12} ${curY - 16} Td (Subtotal:) Tj ET
BT /F1 8.5 Tf ${(totX + totW - 12 - textWidth(subFormatted, 8.5)).toFixed(1)} ${curY - 16} Td (${escapePdf(subFormatted)}) Tj ET
`);

  if (discountAmount > 0 || discountPct > 0) {
    const discLabel = discountPct > 0 ? `Discount (${discountPct}%):` : 'Discount:';
    const discFormatted = `- ${formatInr(discountAmount)}`;
    curStream.push(`
0.15 0.65 0.30 rg
BT /F2 8.5 Tf ${totX + 12} ${curY - 30} Td (${discLabel}) Tj ET
BT /F1 8.5 Tf ${(totX + totW - 12 - textWidth(discFormatted, 8.5)).toFixed(1)} ${curY - 30} Td (${escapePdf(discFormatted)}) Tj ET
`);
  }

  curStream.push(`
0.80 0.83 0.88 RG 0.75 w
${totX + 10} ${curY - 42} m ${totX + totW - 10} ${curY - 42} l S
0.12 0.16 0.24 rg
BT /F2 10 Tf ${totX + 12} ${curY - 54} Td (Total Quoted:) Tj ET
BT /F2 10.5 Tf ${(totX + totW - 12 - textWidth(totFormatted, 10.5, true)).toFixed(1)} ${curY - 54} Td (${escapePdf(totFormatted)}) Tj ET
`);

  curY -= 76;

  // Terms and conditions (numbered and spaced from the list, so a hidden line leaves no gap)
  const terms = [
    'Quoted rates are from the approved rate card and remain locked for this case registration.',
    showValidity && 'This quotation is valid for 15 calendar days from the date of issue.',
    'Final billing will reflect verified service duration, equipment serials, shifts and consumables delivered.',
    'For questions or service confirmations, please call the Hinduja Care Helpline at +91 80493 68621.',
  ].filter(Boolean);
  curStream.push(`
0.40 0.45 0.55 rg
BT /F2 8 Tf ${marginX} ${curY} Td (Terms & Conditions / Care Information:) Tj ET
0.50 0.55 0.65 rg
${terms.map((t, i) => `BT /F1 7.5 Tf ${marginX} ${curY - 12 - i * 10} Td (${escapePdf(`${i + 1}. ${t}`)}) Tj ET`).join('\n')}
`);

  // Footers on all pages
  const totalPages = pages.length;
  for (let p = 0; p < totalPages; p++) {
    const pageNumText = `Page ${p + 1} of ${totalPages}`;
    const ptw = textWidth(pageNumText, 7.5);
    pages[p].push(`
0.82 0.85 0.90 RG 0.5 w
${marginX} 32 m ${marginX + contentWidth} 32 l S
0.55 0.60 0.70 rg
BT /F1 7 Tf ${marginX} 22 Td (Hinduja Home Care Services · Computer-generated quotation · Confidential) Tj ET
BT /F1 7 Tf ${(marginX + contentWidth - ptw).toFixed(1)} 22 Td (${pageNumText}) Tj ET
`);
  }

  // Assemble PDF document
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

  let out = '%PDF-1.4\n';
  const objOffsets = [];

  function writeObj(id, body) {
    objOffsets[id] = out.length;
    out += `${id} 0 obj\n${body}\nendobj\n`;
  }

  writeObj(catalogId, `<< /Type /Catalog /Pages ${pagesTreeId} 0 R >>`);
  writeObj(pagesTreeId, `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  writeObj(fontRegularId, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
  writeObj(fontBoldId, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`);
  writeObj(fontObliqueId, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>`);

  for (let i = 0; i < pages.length; i++) {
    const pageId = pageObjectIds[i];
    const streamId = streamObjectIds[i];
    const streamContent = pages[i].join('\n');
    const streamLen = new TextEncoder().encode(streamContent).length;

    writeObj(pageId, `<< /Type /Page /Parent ${pagesTreeId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents ${streamId} 0 R /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R /F3 ${fontObliqueId} 0 R >> >> >>`);
    writeObj(streamId, `<< /Length ${streamLen} >>\nstream\n${streamContent}\nendstream`);
  }

  const startXref = out.length;
  const totalObjects = 5 + pageObjectIds.length * 2;
  out += `xref\n0 ${totalObjects + 1}\n`;
  out += '0000000000 65535 f \n';
  for (let i = 1; i <= totalObjects; i++) {
    out += String(objOffsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  out += `trailer\n<< /Size ${totalObjects + 1} /Root ${catalogId} 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;

  return new TextEncoder().encode(out);
}

export function downloadQuotationPdf({ k, patient, items = [], workspace = null }) {
  const bytes = generateQuotationPdfBytes({ k, patient, items, workspace });
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Quotation-${k?.case_no || 'enquiry'}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

