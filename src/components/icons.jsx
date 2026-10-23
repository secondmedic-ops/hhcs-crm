// Hand-drawn 16px stroke icon set (no third-party icon packs).
const P = {
  pulse: 'M1.5 8h3l1.5-4 3 8 1.5-4h4',
  headset: 'M3 9V7.5a5 5 0 0 1 10 0V9M3 9h2v4H3.5a.5.5 0 0 1-.5-.5zM13 9h-2v4h1.5a.5.5 0 0 0 .5-.5zM12 13c0 1-1.5 1.8-3.5 1.8',
  folder: 'M1.8 4h4.4l1.4 1.5h6.6v7.7H1.8z',
  return: 'M6 4 3 7l3 3M3 7h7a3.5 3.5 0 0 1 0 7H8',
  phone: 'M4.6 1.8 6.5 4 5.3 5.6a8 8 0 0 0 5 5L12 9.5l2.2 1.9-1 2.4c-6.3-.3-10.9-4.9-11-11z',
  person: 'M8 8a2.8 2.8 0 1 0 0-5.6A2.8 2.8 0 0 0 8 8zM2.5 14.2c.5-2.8 2.8-4.3 5.5-4.3s5 1.5 5.5 4.3',
  pin: 'M8 14.5S3.2 10 3.2 6.4a4.8 4.8 0 0 1 9.6 0C12.8 10 8 14.5 8 14.5zM8 8a1.6 1.6 0 1 0 0-3.2A1.6 1.6 0 0 0 8 8z',
  stamp: 'M6 2h4v3.5l2.5 2V10h-9V7.5L6 5.5zM2.5 12.5h11v1.8h-11z',
  flag: 'M3.5 14.5V2M3.5 2.5h8l-2 3 2 3h-8',
  alert: 'M8 1.8 14.6 13.5H1.4zM8 6v3.6M8 11.3v.1',
  report: 'M3 1.8h7l3 3v9.4H3zM10 1.8v3h3M5.5 8.5h5M5.5 11h5M5.5 6h2',
  shield: 'M8 1.6 13.4 3.5v4c0 3.4-2.3 5.8-5.4 6.9-3.1-1.1-5.4-3.5-5.4-6.9v-4zM5.6 8l1.7 1.7 3.1-3.3',
  gear: 'M8 10.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.7 10.7 14.3 14.3',
  bell: 'M4 11.5V7a4 4 0 0 1 8 0v4.5l1.3 1.3H2.7zM6.5 14.3h3',
  plus: 'M8 3v10M3 8h10',
  x: 'M3.5 3.5l9 9M12.5 3.5l-9 9',
  check: 'M3 8.4 6.4 11.6 13 4.6',
  chevron: 'M6 3.5 10.5 8 6 12.5',
  down: 'M3.5 6 8 10.5 12.5 6',
  play: 'M5 3v10l8-5z',
  pause: 'M5 3v10M11 3v10',
  clock: 'M8 14.3A6.3 6.3 0 1 0 8 1.7a6.3 6.3 0 0 0 0 12.6zM8 4.5V8l2.5 1.6',
  rupee: 'M4.5 2.5h7M4.5 5.3h7M6 2.5c3.8 0 3.8 5.6 0 5.6H4.5l5.5 5.5',
  mail: 'M1.8 3.5h12.4v9H1.8zM2 4l6 4.8L14 4',
  chat: 'M2 3h12v8H7l-3.5 2.8V11H2z',
  note: 'M3 2h10v8.5L9.5 14H3zM9.5 14v-3.5H13',
  cog: 'M8 1.5v2',
  lab: 'M6 1.8v4.3L2.7 12.5a1.2 1.2 0 0 0 1 1.7h8.6a1.2 1.2 0 0 0 1-1.7L10 6.1V1.8M5 1.8h6M4.5 9.5h7',
  wave: 'M1 8h2l1.5-3 2 6 2-9 2 9 1.5-3H15',
  sys: 'M2 3h12v8H2zM5.5 14h5M8 11v3',
  edit: 'M10.5 2.5l3 3L6 13H3v-3z',
  out: 'M10 3h3.5v10H10M6.5 5 3.5 8l3 3M3.5 8h7',
  menu: 'M2 4h12M2 8h12M2 12h12',
  download: 'M8 2v8.5M4.5 7 8 10.5 11.5 7M2.5 13.5h11',
  print: 'M4 6V2h8v4M4 11.5H2.5V6h11v5.5H12M4.5 9.5h7v5h-7z',
  refresh: 'M13 3v3.5H9.5M3 13V9.5h3.5M12.3 6.5A4.8 4.8 0 0 0 3.6 6M3.7 9.5a4.8 4.8 0 0 0 8.7.5',
  spark: 'M2 12.5l3.2-4 2.6 2.4L13.8 3.5M10.4 3.5h3.4v3.4',
  board: 'M2 2.5h3.5v11H2zM6.3 2.5h3.5v7H6.3zM10.5 2.5H14v9h-3.5z',
  list: 'M5 4h9M5 8h9M5 12h9M2 4h.1M2 8h.1M2 12h.1',
  link: 'M6.5 9.5l3-3M5.2 7.3 3.6 8.9a2.5 2.5 0 0 0 3.5 3.5l1.6-1.6M10.8 8.7l1.6-1.6a2.5 2.5 0 0 0-3.5-3.5L7.3 5.2',
  lock: 'M3.5 7.5h9v6.5h-9zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5',
  ai: 'M3 13 7 3h2l4 10M4.6 9.5h6.8',
  callin: 'M10 2.5v4h4M14 2.5 10 6.5M4.6 1.8 6.5 4 5.3 5.6a8 8 0 0 0 5 5L12 9.5l2.2 1.9-1 2.4c-6.3-.3-10.9-4.9-11-11z',
  callout: 'M14 6.5v-4h-4M10 6.5l4-4M4.6 1.8 6.5 4 5.3 5.6a8 8 0 0 0 5 5L12 9.5l2.2 1.9-1 2.4c-6.3-.3-10.9-4.9-11-11z',
  swap: 'M2.5 5.5h10l-2.5-2.5M13.5 10.5h-10l2.5 2.5',
  barcode: 'M2 3v10M4 3v10M6.5 3v10M8 3v10M10.5 3v10M12 3v10M14 3v10',
  hang: 'M1.5 9.5c3.8-3.4 9.2-3.4 13 0l-1.6 2-2.5-1V8.6a8.5 8.5 0 0 0-4.8 0v1.9l-2.5 1z',
  send: 'M14 2 2 7.2l4.8 2L9 14zM6.8 9.2 14 2',
  eye: 'M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  eyeoff: 'M1 8s2.5-5 7-5c1.4 0 2.7.5 3.8 1.2M15 8s-2.5 5-7 5c-1.4 0-2.7-.5-3.8-1.2M2 2l12 12',
};

export default function Icon({ name, size = 16, stroke = 1.4, className, title }) {
  const d = P[name] || P.note;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={stroke}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={d} />
    </svg>
  );
}

export const channelIcon = (c) => ({ phone: 'phone', whatsapp: 'chat', sms: 'chat', email: 'mail', chat: 'chat', note: 'note', system: 'sys', crm_edit: 'edit', field: 'pin', lab: 'lab', payment: 'rupee' }[c] || 'note');
