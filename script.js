/* ...existing code... */
import marked from "marked";
import DOMPurify from "dompurify";

const form = document.getElementById('resolve-form');
const input = document.getElementById('project-input');
const statusEl = document.getElementById('status');
const area = document.getElementById('supporters-area');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');

let projectId = null;
let cursors = { before: null, after: null, startCursor: null, endCursor: null };

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? 'crimson' : '';
}

function safeRenderMarkdown(raw) {
  // Convert markdown to HTML and sanitize. Limit image sizes via inline style wrapper.
  const html = marked.parse(raw || '');
  const sanitized = DOMPurify.sanitize(html, {ADD_ATTR: ['target']});
  // enforce max sizes on images
  const wrapper = document.createElement('div');
  wrapper.innerHTML = sanitized;
  wrapper.querySelectorAll('img').forEach(img => {
    img.style.maxWidth = '320px';
    img.style.maxHeight = '320px';
    img.loading = 'lazy';
  });
  return wrapper.innerHTML;
}

async function resolveProjectIdFromInput(val) {
  val = val.trim();
  if (!val) throw new Error('Empty input');
  // If it's already a UUID-like id or numeric id, assume it's project id
  const maybeId = val.match(/[a-z0-9_-]{6,}/i);
  // If input looks like a full URL containing /projects/ or /@username/slug
  try {
    const url = new URL(val);
    const path = url.pathname;
    // pattern: /@username/slug or /users/username/projects/slug
    let m = path.match(/^\/@?([^\/]+)\/([^\/]+)\/?$/);
    if (m) {
      const username = m[1].replace(/^@/, '');
      const slug = m[2];
      // call slugs resolve
      return await resolveSlug(username, slug);
    }
    // pattern: /projects/{id}
    m = path.match(/\/projects\/([^\/]+)\/?/);
    if (m) return m[1];
    // fallback: last path segment
    const last = path.split('/').filter(Boolean).pop();
    if (last && last.length > 8) return last;
  } catch (e) {
    // not a URL, maybe "username/slug" or "@username/slug"
    const parts = val.split('/');
    if (parts.length === 2) {
      const username = parts[0].replace(/^@/, '');
      const slug = parts[1];
      return await resolveSlug(username, slug);
    }
    // otherwise treat as project id
    return val;
  }
  // fallback if regex matched an id-like segment
  if (maybeId) return maybeId[0];
  throw new Error('Could not parse input');
}

async function resolveSlug(username, slug) {
  setStatus(`Resolving ${username}/${slug}...`);
  const res = await fetch(`/api/v1/users/${encodeURIComponent(username)}/slugs/${encodeURIComponent(slug)}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Slug resolve failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  // response is expected to include canonical project id (id)
  if (data && data.project && data.project.id) return data.project.id;
  // fallback: data.id or data.project_id
  return data.id || data.project_id || (() => { throw new Error('No project id in slug response'); })();
}

async function fetchTipComments({ after = null, before = null } = {}) {
  if (!projectId) throw new Error('Missing project id');
  const params = new URLSearchParams();
  params.set('only_tips', 'true');
  if (after) params.set('after', after);
  if (before) params.set('before', before);
  const url = `/api/v1/projects/${encodeURIComponent(projectId)}/comments?${params.toString()}`;
  setStatus('Loading supporters...');
  const res = await fetch(url);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Failed to load comments: ${res.status} ${t}`);
  }
  const json = await res.json();
  return json.comments;
}

function renderSupporters(commentsData) {
  area.innerHTML = '';
  if (!commentsData || !commentsData.data || commentsData.data.length === 0) {
    setStatus('No tip comments found for this project.');
    return;
  }
  setStatus(`Showing ${commentsData.data.length} supporter(s).`);
  commentsData.data.forEach(item => {
    const c = item.comment;
    const el = document.createElement('div');
    el.className = 'supporter';
    const avatarUrl = (c.author && c.author.avatar_url) || '';
    el.innerHTML = `
      <div class="avatar">${avatarUrl ? `<img alt="${escapeHtml((c.author && c.author.username) || '')}" src="${avatarUrl}">` : ''}</div>
      <div class="supporter-main">
        <div class="meta">
          <div>
            <div class="name">${escapeHtml((c.author && (c.author.display_name || c.author.username)) || 'Anonymous')}</div>
            <div class="username">@${escapeHtml((c.author && c.author.username) || 'unknown')}</div>
          </div>
          <div class="amount">${(c.card_data && c.card_data.credits_spent) ? `${c.card_data.credits_spent} credits` : ''}</div>
        </div>
        <div class="created">${new Date(c.created_at).toLocaleString()}</div>
        <div class="comment">${safeRenderMarkdown(c.raw_content || '')}</div>
      </div>
    `;
    area.appendChild(el);
  });
}

function escapeHtml(s){ return String(s || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

async function loadAndRender({ after = null, before = null } = {}) {
  try {
    const comments = await fetchTipComments({ after, before });
    // store cursors & meta for pagination
    cursors = {
      startCursor: comments.meta?.start_cursor || null,
      endCursor: comments.meta?.end_cursor || null,
      hasNext: comments.meta?.has_next_page || false,
      hasPrevious: comments.meta?.has_previous_page || false,
      afterCursor: after || null,
      beforeCursor: before || null
    };
    renderSupporters(comments);
    prevBtn.disabled = !cursors.hasPrevious;
    nextBtn.disabled = !cursors.hasNext;
  } catch (err) {
    setStatus(err.message || String(err), true);
    area.innerHTML = '';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
  }
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    projectId = null;
    area.innerHTML = '';
    prevBtn.disabled = true; nextBtn.disabled = true;
    const val = input.value.trim();
    if (!val) { setStatus('Enter a project url or id', true); return; }
    setStatus('Parsing input...');
    projectId = await resolveProjectIdFromInput(val);
    setStatus(`Resolved project id: ${projectId}. Loading supporters...`);
    await loadAndRender();
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
});

nextBtn.addEventListener('click', async () => {
  if (!cursors.hasNext) return;
  await loadAndRender({ after: cursors.endCursor });
});

prevBtn.addEventListener('click', async () => {
  if (!cursors.hasPrevious) return;
  await loadAndRender({ before: cursors.startCursor });
});

/* ...existing code... */

