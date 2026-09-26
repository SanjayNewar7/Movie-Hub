let token = sessionStorage.getItem('mh_reports_token') || '';
let reports = [];
const $ = id => document.getElementById(id);
const text = value => document.createTextNode(String(value ?? ''));
const cell = (row, value) => { const td = row.insertCell(); td.append(text(value)); return td; };

async function request(path = '', options = {}) {
  const response = await fetch('/api/reports' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function bars(id, items, name) {
  const root = $(id);
  root.replaceChildren();
  if (!items.length) { root.append(text('No data yet.')); return; }
  const max = Math.max(...items.map(x => x.count), 1);
  for (const item of items) {
    const row = document.createElement('div'); row.className = 'bar';
    const label = document.createElement('span'); label.append(text(item[name]));
    const track = document.createElement('div');
    const fill = document.createElement('i'); fill.style.width = `${item.count / max * 100}%`;
    track.append(fill);
    const count = document.createElement('small'); count.append(text(item.count));
    row.append(label, track, count); root.append(row);
  }
}

function renderRows() {
  const query = $('search').value.toLowerCase().trim();
  const filter = $('filter').value;
  const items = reports.filter(r =>
    (filter === 'all' || r.status === filter) &&
    (!query || `${r.id} ${r.movieTitle} ${r.reason} ${r.detail}`.toLowerCase().includes(query)));
  const tbody = $('rows'); tbody.replaceChildren(); $('empty').hidden = items.length > 0;
  for (const report of items) {
    const row = tbody.insertRow();
    const id = cell(row, report.id); id.className = 'id';
    const date = document.createElement('small');
    date.append(text(new Date(report.createdAt).toLocaleString())); id.append(date);
    const movie = row.insertCell(); const link = document.createElement('a');
    link.href = `/#movie-${encodeURIComponent(report.movieId)}`;
    link.addEventListener('click', event => {
      event.preventDefault();
      sessionStorage.setItem('mh_open_movie', report.movieId);
      location.href = '/';
    });
    link.append(text(report.movieTitle)); movie.append(link);
    cell(row, report.reason); cell(row, report.detail || '—');
    const status = row.insertCell();
    const badge = document.createElement('span'); badge.className = `badge ${report.status}`;
    badge.append(text(report.status)); status.append(badge, document.createElement('br'));
    const action = document.createElement('button'); action.className = 'secondary';
    action.style.marginTop = '9px'; action.style.padding = '5px 9px';
    action.append(text(report.status === 'open' ? 'Resolve' : 'Reopen'));
    action.addEventListener('click', async () => {
      action.disabled = true;
      try {
        await request('/' + encodeURIComponent(report.id), {
          method: 'PATCH', body: JSON.stringify({ status: report.status === 'open' ? 'resolved' : 'open' }),
        });
        await load();
      } catch (error) { $('message').textContent = error.message; action.disabled = false; }
    });
    status.append(action);
  }
}

async function load() {
  const data = await request();
  reports = data.reports;
  $('total').textContent = data.stats.total;
  $('open').textContent = data.stats.open;
  $('reported').textContent = new Set(reports.map(r => r.movieId)).size;
  const names = { title_mismatch: 'Title differs', not_playing: 'Not playing', lagging: 'Lagging', wrong_thumbnail: 'Wrong poster', other: 'Other' };
  bars('types', Object.entries(data.stats.byType).map(([type, count]) => ({ title: names[type] || type, count })), 'title');
  bars('most-reported', data.stats.mostReported, 'title');
  bars('most-liked', data.stats.mostLiked, 'title');
  renderRows();
  $('login').style.display = 'none'; $('message').textContent = '';
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); token = $('password').value;
  try { await load(); sessionStorage.setItem('mh_reports_token', token); }
  catch (error) { $('login-error').textContent = error.message; token = ''; }
});
$('refresh').addEventListener('click', () => load().catch(error => $('message').textContent = error.message));
$('search').addEventListener('input', renderRows);
$('filter').addEventListener('change', renderRows);
if (token) load().catch(() => { sessionStorage.removeItem('mh_reports_token'); token = ''; });
