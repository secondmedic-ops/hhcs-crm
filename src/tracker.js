// Customer feedback capabilities and comments must never reach error analytics.
if (window.location.pathname !== '/feedback') {
  const script = document.createElement('script');
  script.src = 'https://system-tracker.secondmedic.workers.dev/t.js';
  script.dataset.project = 'caredesk-crm';
  document.head.appendChild(script);
}
