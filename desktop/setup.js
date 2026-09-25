const form = document.getElementById('f');
const input = document.getElementById('url');
const err = document.getElementById('err');
const btn = document.getElementById('go');
const current = new URLSearchParams(location.search).get('current');
if (current) input.value = current;
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = ''; btn.disabled = true; btn.textContent = 'Checking…';
  try { await window.aventra.connect(input.value); } catch (ex) {
    err.textContent = String(ex.message || ex).replace(/^Error invoking remote method 'setup:connect': (Error: )?/, '');
    btn.disabled = false; btn.textContent = 'Connect';
  }
});
