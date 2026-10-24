// Hinduja inbound call policy. The provider owns audio, live queue/transfer, SMS and voicemail.
export const IVR_NODES = ['main_menu', 'after_hours', 'information', 'billing', 'homecare', 'emergency', 'hold', 'callback_offer', 'callback_confirm', 'voicemail'] as const;
export type IvrAction = typeof IVR_NODES[number];
export type IvrState = {
  afterHours: boolean; queuedAt?: number; retries?: number; callbackId?: string;
  terminal?: IvrAction; lastRequest?: string; lastAction?: IvrAction;
};

export function officeHours(now: Date) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(now));
  return hour >= 8 && hour < 20;
}

/** The next office opening, or now during office hours. No holiday/weekend exclusions were requested. */
export function callbackStart(now: Date): Date {
  if (officeHours(now)) return now;
  const local = new Date(now.getTime() + 330 * 60_000);
  if (local.getUTCHours() >= 20) local.setUTCDate(local.getUTCDate() + 1);
  local.setUTCHours(8, 0, 0, 0);
  return new Date(local.getTime() - 330 * 60_000);
}

export function decideIvr(state: IvrState, step: string, digit: string, free: boolean, now: number): IvrAction | 'callback' {
  if (state.terminal) return state.terminal;
  if (step === 'entry') return state.lastAction || (state.afterHours ? 'after_hours' : 'main_menu');
  if (step === 'queue') {
    if (state.queuedAt == null) throw new Error('Call has not entered the homecare queue');
    if (free) return 'homecare';
    return now - state.queuedAt < 180_000 ? 'hold' : 'callback_offer';
  }
  if (step === 'menu' && state.lastAction === 'main_menu') {
    if (digit === '1') return 'information';
    if (digit === '2') return 'billing';
    if (digit === '5') { state.queuedAt ??= now; return free ? 'homecare' : 'hold'; }
  } else if (step === 'after_hours' && state.lastAction === 'after_hours') {
    if (digit === '1') return 'emergency';
    if (digit === '2') return 'callback';
  } else if (step === 'callback_offer' && state.lastAction === 'callback_offer') {
    if (digit === '1') return 'callback';
    if (digit === '2') return 'voicemail';
  } else throw new Error('Unexpected IVR step');
  state.retries = (state.retries || 0) + 1;
  return state.retries >= 3 ? 'voicemail' : state.lastAction!;
}
