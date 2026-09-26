let token = sessionStorage.getItem('mh_reports_token') || '';
let reports = [];

const $ = id => document.getElementById(id);
const text = value => document.createTextNode(String(value ?? ''));

function cell(row, value) {
  const td = row.insertCell();
  td.append(text(value));
  return td;
}

async function request(path = '', options = {}) {
  const response = await fetch('/api/reports' + path, {
    ...options,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  const raw = await response.text();
  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `Server error (HTTP ${response.status}). Check Netlify function logs.`
    );
  }

  if (response.status === 401) {
    sessionStorage.removeItem('mh_reports_token');
    throw new Error(
      'Password rejected. Check ADMIN_PASSWORD in Netlify and redeploy after changing it.'
    );
  }

  if (response.status >= 500) {
    throw new Error(
      `Server error (HTTP ${response.status}). Check Netlify function logs.`
    );
  }

  if (!response.ok) {
    throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
  }

  return data;
}

function bars(id, items, name) {
  const root = $(id);
  root.replaceChildren();

  if (!Array.isArray(items) || items.length === 0) {
    root.append(text('No data yet.'));
    return;
  }

  const max = Math.max(...items.map(item => Number(item.count) || 0), 1);

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'bar';

    const label = document.createElement('span');
    label.append(text(item[name]));

    const track = document.createElement('div');
    const fill = document.createElement('i');
    fill.style.width = `${(Number(item.count) || 0) / max * 100}%`;
    track.append(fill);

    const count = document.createElement('small');
    count.append(text(item.count));

    row.append(label, track, count);
    root.append(row);
  }
}

function renderRows() {
  const query = $('search').value.toLowerCase().trim();
  const filter = $('filter').value;

  const items = reports.filter(report => {
    const matchesStatus =
      filter === 'all' || report.status === filter;

    const searchable =
      `${report.id} ${report.movieTitle} ${report.reason} ${report.detail || ''}`
        .toLowerCase();

    return matchesStatus && (!query || searchable.includes(query));
  });

  const tbody = $('rows');
  tbody.replaceChildren();
  $('empty').hidden = items.length > 0;

  for (const report of items) {
    const row = tbody.insertRow();

    const id = cell(row, report.id);
    id.className = 'id';

    const date = document.createElement('small');
    date.append(text(new Date(report.createdAt).toLocaleString()));
    id.append(date);

    const movie = row.insertCell();
    const link = document.createElement('a');

    link.href = `/#movie-${encodeURIComponent(report.movieId)}`;
    link.append(text(report.movieTitle));

    link.addEventListener('click', event => {
      event.preventDefault();
      sessionStorage.setItem('mh_open_movie', report.movieId);
      location.href = '/';
    });

    movie.append(link);

    cell(row, report.reason);
    cell(row, report.detail || '—');

    const status = row.insertCell();
    const badge = document.createElement('span');
    badge.className = `badge ${report.status === 'resolved' ? 'resolved' : 'open'}`;
    badge.append(text(report.status));
    status.append(badge, document.createElement('br'));

    const action = document.createElement('button');
    action.className = 'secondary';
    action.style.marginTop = '9px';
    action.style.padding = '5px 9px';
    action.append(text(report.status === 'open' ? 'Resolve' : 'Reopen'));

    action.addEventListener('click', async () => {
      action.disabled = true;
      $('message').textContent = '';

      try {
        await request('/' + encodeURIComponent(report.id), {
          method: 'PATCH',
          body: JSON.stringify({
            status: report.status === 'open' ? 'resolved' : 'open',
          }),
        });

        await load();
      } catch (error) {
        $('message').textContent = error.message;
        action.disabled = false;
      }
    });

    status.append(action);
  }
}

async function load() {
  const data = await request();

  if (!Array.isArray(data.reports) || !data.stats) {
    throw new Error('The server returned an invalid dashboard response.');
  }

  reports = data.reports;

  $('total').textContent = data.stats.total ?? 0;
  $('open').textContent = data.stats.open ?? 0;
  $('reported').textContent =
    new Set(reports.map(report => report.movieId)).size;

  const names = {
    title_mismatch: 'Title differs',
    not_playing: 'Not playing',
    lagging: 'Lagging',
    wrong_thumbnail: 'Wrong poster',
    other: 'Other',
  };

  const reasonCounts = Object.entries(data.stats.byType || {})
    .map(([type, count]) => ({
      title: names[type] || type,
      count,
    }));

  bars('types', reasonCounts, 'title');
  bars('most-reported', data.stats.mostReported || [], 'title');
  bars('most-liked', data.stats.mostLiked || [], 'title');

  renderRows();

  $('login').style.display = 'none';
  $('message').textContent = '';
  $('login-error').textContent = '';
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();

  token = $('password').value;
  $('login-error').textContent = '';

  const button = event.currentTarget.querySelector('button[type="submit"], button');
  if (button) button.disabled = true;

  try {
    await load();
    sessionStorage.setItem('mh_reports_token', token);
    $('password').value = '';
  } catch (error) {
    $('login-error').textContent = error.message;
    token = '';
    sessionStorage.removeItem('mh_reports_token');
  } finally {
    if (button) button.disabled = false;
  }
});

$('refresh').addEventListener('click', async () => {
  const button = $('refresh');
  button.disabled = true;
  $('message').textContent = '';

  try {
    await load();
  } catch (error) {
    $('message').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('search').addEventListener('input', renderRows);
$('filter').addEventListener('change', renderRows);

if (token) {
  load().catch(error => {
    $('login-error').textContent = error.message;
    sessionStorage.removeItem('mh_reports_token');
    token = '';
  });
}
