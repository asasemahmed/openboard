// Apply the saved theme before first paint so the page never flashes the wrong colours.
// A separate file, not an inline script, so the Content-Security-Policy can forbid inline scripts.
try {
  var pref = JSON.parse(localStorage.getItem('openboard.theme') || '"system"');
  if (pref === 'light' || pref === 'dark') document.documentElement.dataset.theme = pref;
} catch (e) {}
