const $ = id => document.getElementById(id);
const labels = {
    starting: '准备中', running: '执行中', generating: '生成中', finishing: '生成中',
    generating_arguments: '生成参数中', requested: '等待执行', completed: '已完成',
    success: '已完成', error: '执行失败', denied: '已拒绝', suspended: '等待补充',
    queued: '已排队', interrupted: '已中断', cancelled: '已取消', failed: '执行失败'
};
let session = new URLSearchParams(location.search).get('session')
    || localStorage.getItem('session-chat.selected') || crypto.randomUUID();
let source, snapshot, cursor = 0, eventCursor = 0, trace = new Map(), pendingRun;
let sessionIds = [], reloadTimer, refreshing = false, refreshAgain = false;
let connectVersion = 0, selectionVersion = 0, connected = true;
const MAX_MEDIA_FILES = 4, MAX_MEDIA_BYTES = 4 * 1024 * 1024;
let attachments = [];
// Re-renders rebuild message nodes every snapshot; remember which thinking sections stay open.
const openThinking = new Set();
const short = value => value ? value.slice(0, 8) : '—';
const path = () => `/api/sessions/${encodeURIComponent(session)}`;

async function request(url, body) {
    const response = await fetch(url, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`);
    return data;
}
function notice(error) { $('notice').textContent = error?.message || error || ''; }
function syncSend() {
    const busy = ['starting', 'running'].includes((pendingRun || snapshot?.turns.at(-1))?.status);
    $('send').disabled = ($('input-mode').value === 'steer' && !busy)
        || (!$('prompt').value.trim() && !attachments.length);
}
function renderAttachments() {
    $('attach-hint').textContent = attachments.length
        ? `已选 ${attachments.length} / ${MAX_MEDIA_FILES} 个附件` : '';
    $('attachments').replaceChildren(...attachments.map((attachment, index) => {
        const chip = document.createElement('div'); chip.className = 'attachment';
        const preview = document.createElement(attachment.kind);
        preview.src = attachment.preview;
        if (attachment.kind === 'video') preview.muted = true;
        const name = document.createElement('span'); name.textContent = attachment.file.name || attachment.kind;
        const remove = document.createElement('button');
        remove.type = 'button'; remove.textContent = '×'; remove.title = '移除';
        remove.setAttribute('aria-label', `移除 ${name.textContent}`);
        remove.onclick = () => {
            URL.revokeObjectURL(attachment.preview);
            attachments.splice(index, 1); renderAttachments(); syncSend();
        };
        chip.append(preview, name, remove);
        return chip;
    }));
}
function addFiles(files) {
    notice('');
    for (const file of files) {
        const kind = file.type.startsWith('image/') ? 'img' : file.type.startsWith('video/') ? 'video' : '';
        if (!kind) { notice('只能发送图片或视频文件'); continue; }
        if (file.size > MAX_MEDIA_BYTES) { notice('单个图片或视频不能超过 4 MB'); continue; }
        if (attachments.length >= MAX_MEDIA_FILES) { notice(`一次最多发送 ${MAX_MEDIA_FILES} 个图片或视频`); break; }
        attachments.push({ file, kind, mediaType: file.type, preview: URL.createObjectURL(file) });
    }
    renderAttachments(); syncSend();
}
function clearAttachments() {
    attachments.forEach(attachment => URL.revokeObjectURL(attachment.preview));
    attachments = []; renderAttachments(); syncSend();
}
function readBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result);
            resolve(result.slice(result.indexOf(',') + 1));
        };
        reader.onerror = () => reject(reader.error || new Error('无法读取所选文件'));
        reader.readAsDataURL(file);
    });
}
async function mediaPayload() {
    return Promise.all(attachments.map(async attachment => ({
        media_type: attachment.mediaType, data: await readBase64(attachment.file)
    })));
}
function text(blocks) {
    return (blocks || []).map(block => {
        if (block.type === 'text') return block.text || '';
        // Thinking lives in its own collapsible section; keep it out of the main text.
        if (block.type === 'tool_result') return text(block.output);
        return '';
    }).filter(Boolean).join('\n');
}
function thinkingText(blocks) {
    return (blocks || [])
        .map(block => block.type === 'thinking' ? block.thinking || '' : '')
        .filter(Boolean).join('\n');
}
function addThinking(node, blocks, id) {
    const value = thinkingText(blocks);
    if (!value) return;
    const details = document.createElement('details');
    details.className = 'thinking';
    if (openThinking.has(id)) details.open = true;
    details.ontoggle = () => {
        if (details.open) openThinking.add(id);
        else openThinking.delete(id);
    };
    const summary = document.createElement('summary');
    summary.textContent = '思维链';
    details.append(summary);
    const body = document.createElement('div');
    body.className = 'thinking-body';
    body.textContent = value;
    details.append(body);
    // Reasoning precedes the answer: insert right after the role label, before the reply text.
    node.insertBefore(details, node.querySelector('.text') || null);
}
function bubble(role, value, className = role) {
    const node = document.createElement('article');
    node.className = `message ${className}`;
    const label = document.createElement('div'); label.className = 'role'; label.textContent = role;
    const content = document.createElement('div'); content.className = 'text'; content.textContent = value;
    node.append(label, content);
    return node;
}
function mediaNode(block) {
    const source = block.source || {};
    const src = source.type === 'base64' && source.data
        ? `data:${source.media_type};base64,${source.data}` : source.url;
    if (!src) return null;
    const node = document.createElement(block.type === 'video' ? 'video' : 'img');
    node.src = src;
    if (block.type === 'video') node.controls = true;
    else { node.alt = '图片'; node.loading = 'lazy'; }
    return node;
}
function addMedia(node, blocks, value) {
    const media = (blocks || []).filter(block => block.type === 'image' || block.type === 'video')
        .map(mediaNode).filter(Boolean);
    if (!media.length) return;
    const box = document.createElement('div'); box.className = 'media';
    box.append(...media); node.append(box);
}
function renderItem(item) {
    const state = labels[item.status] || item.status;
    let node;
    if (item.kind === 'tool') {
        const call = item.content.find(block => block.type === 'tool_use');
        const result = item.content.find(block => block.type === 'tool_result');
        const args = call && Object.keys(call.input || {}).length
            ? JSON.stringify(call.input) : call?.content || '';
        node = bubble(`${call?.name || result?.name || '工具'} · ${state}`,
            `参数：${args || '等待参数'}${result ? '\n结果：' + text(result.output) : ''}`, 'tool');
        if (item.progress.length) {
            const progress = document.createElement('div'); progress.className = 'tool-progress';
            progress.textContent = '执行进度\n' + text(item.progress); node.append(progress);
        }
    } else {
        const value = text(item.content);
        node = bubble(item.status === 'completed' ? item.role : `${item.role} · ${state}`,
            value, item.role);
        if (!value) node.querySelector('.text')?.remove();
        addThinking(node, item.content, item.id);
        addMedia(node, item.content, value);
    }
    node.dataset.itemId = item.id;
    node.dataset.status = item.status;
    return node;
}
function render() {
    $('session-label').textContent = `session ${session}`;
    $('export').href = `${path()}/export`;
    $('cursor').textContent = cursor;
    $('checkpoint').textContent = snapshot?.checkpointSeq || 0;
    $('counts').textContent = `${snapshot?.messages.length || 0} / ${snapshot?.workingMessages || 0}`;
    const latest = snapshot?.turns.at(-1);
    if (latest?.runId === pendingRun?.runId) pendingRun = undefined;
    const active = pendingRun || latest;
    const busy = ['starting', 'running'].includes(active?.status);
    $('status').textContent = labels[active?.status] || '就绪';
    $('run-label').textContent = active ? `turn ${short(active.turnId)} · run ${short(active.runId)}` : '';
    $('interrupt').hidden = !busy;
    $('resume').hidden = busy || !latest || !['interrupted', 'failed', 'suspended'].includes(latest.status)
        || snapshot.pending.length > 0;
    syncSend();
    $('queue').textContent = (snapshot?.tasks || []).filter(task => task.status === 'queued')
        .map(task => `排队任务 ${short(task.turnId)}`).join(' · ');
    const nodes = (snapshot?.items || []).map(renderItem);
    const messages = $('messages');
    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
    const scrollTop = messages.scrollTop;
    messages.replaceChildren(...(nodes.length ? nodes : [bubble('', '发送一条消息，开始这段会话。', 'empty')]));
    messages.scrollTop = atBottom ? messages.scrollHeight : scrollTop;
    $('trace').replaceChildren(...[...trace.values()].reverse().map(event => {
        const li = document.createElement('li'), button = document.createElement('button');
        const seq = document.createElement('span'); seq.className = 'seq'; seq.textContent = event.seq;
        const type = document.createElement('span'); type.className = 'event'; type.textContent = event.type;
        button.append(seq, type); button.title = `turn ${event.turnId || '—'} / run ${event.runId || '—'}`;
        button.onclick = async () => {
            try {
                const records = await request(`${path()}/events?after=${encodeURIComponent(session + ':' + (event.seq - 1))}&limit=1`);
                $('payload').textContent = JSON.stringify(records[0], null, 2); $('detail').showModal();
            } catch (error) { notice(error); }
        };
        li.append(button); return li;
    }));
    // Keep answer forms (including focus and partially typed input) during view refreshes.
    const pendingIds = (snapshot?.pending || []).map(event => event.data.requestId);
    for (const form of [...$('pending').children]) if (!pendingIds.includes(form.dataset.requestId)) form.remove();
    for (const event of snapshot?.pending || []) {
        let form = [...$('pending').children].find(node => node.dataset.requestId === event.data.requestId);
        if (!form) {
            form = document.createElement('form'); form.dataset.requestId = event.data.requestId;
            const question = document.createElement('p'), input = document.createElement('input');
            const button = document.createElement('button');
            question.textContent = event.data.call?.input?.question || '请提供外部执行结果';
            input.name = event.data.requestId; input.required = true; input.maxLength = 8000;
            input.setAttribute('aria-label', question.textContent); button.textContent = '提交并继续';
            form.append(question, input, button);
            form.onsubmit = async e => {
                e.preventDefault();
                await action(() => request(`${path()}/answers`, { request_id: input.name, output: input.value }));
            };
            $('pending').append(form);
        }
        form.querySelector('button').disabled = busy;
    }
}
async function loadSnapshot() {
    const version = selectionVersion;
    const data = await request(path());
    if (version !== selectionVersion) return;
    const seq = Number(data.cursor.split(':').at(-1));
    // A newer SSE notification does not invalidate a useful view. Only a newer applied view does.
    if (seq < cursor) return;
    snapshot = data; cursor = seq;
    for (const event of data.trace) trace.set(event.seq, event);
    if (data.executionError) { pendingRun = undefined; notice(data.executionError); }
    render();
}
function scheduleSnapshot() {
    refreshAgain = true;
    if (reloadTimer || refreshing) return;
    reloadTimer = setTimeout(async () => {
        reloadTimer = undefined; refreshing = true; refreshAgain = false;
        try { await loadSnapshot(); } catch (error) { notice(error); }
        finally {
            refreshing = false;
            if (refreshAgain || (connected && pendingRun)) scheduleSnapshot();
        }
    }, 150);
}
async function connect() {
    source?.close(); source = undefined;
    const version = ++connectVersion, selected = session;
    await loadSnapshot();
    if (!connected || selected !== session || version !== connectVersion || !snapshot) return;
    eventCursor = cursor;
    const events = new EventSource(`${path()}/stream?after=${encodeURIComponent(snapshot.cursor)}`);
    source = events;
    events.onopen = () => {
        if (source !== events) return;
        $('connection').textContent = '事件已连接'; scheduleSnapshot();
    };
    events.onerror = () => {
        if (source === events) $('connection').textContent = '连接中断，自动重连中';
    };
    events.addEventListener('committed', message => {
        if (selected !== session || source !== events) return;
        try {
            const event = JSON.parse(message.data);
            if (event.seq <= eventCursor) return;
            eventCursor = event.seq;
            trace.set(event.seq, event);
            scheduleSnapshot();
        } catch (error) { notice(error); }
    });
}
async function loadList() {
    const version = selectionVersion;
    const data = await request('/api/sessions');
    if (version !== selectionVersion) return;
    $('model').textContent = data.model;
    sessionIds = [...new Set([...sessionIds, ...data.sessions, session])].sort();
    const list = $('sessions'), scrollTop = list.scrollTop;
    const unchanged = [...list.options].map(option => option.value).join(',') === sessionIds.join(',');
    if (!unchanged) list.replaceChildren(...sessionIds.map(id => {
        const option = document.createElement('option'); option.value = id; option.textContent = id; return option;
    }));
    list.value = session;
    list.scrollTop = scrollTop;
}
async function select(id) {
    source?.close(); source = undefined; selectionVersion++; connectVersion++;
    clearTimeout(reloadTimer); reloadTimer = undefined; refreshAgain = false;
    session = id; cursor = 0; eventCursor = 0; snapshot = undefined; pendingRun = undefined; trace.clear();
    openThinking.clear();
    clearAttachments();
    localStorage.setItem('session-chat.selected', session);
    history.replaceState(null, '', `?session=${encodeURIComponent(session)}`);
    notice(''); render(); await loadList(); await connect();
}
async function action(work) {
    const version = selectionVersion;
    try {
        notice(''); const started = await work();
        if (version !== selectionVersion) return;
        if (started?.runId) pendingRun = started;
        render(); scheduleSnapshot();
    } catch (error) { if (version === selectionVersion) notice(error); }
}
$('compose').onsubmit = async event => {
    event.preventDefault();
    const message = $('prompt').value.trim();
    if (!message && !attachments.length) { notice('请输入消息，或选择图片 / 视频'); return; }
    const mode = $('input-mode').value;
    let media;
    try { media = await mediaPayload(); } catch (error) { notice(error); return; }
    if (mode !== 'submit') {
        await action(async () => {
            const ack = await request(`${path()}/${mode}`, { message, attachments: media });
            $('prompt').value = ''; clearAttachments(); return ack;
        });
        return;
    }
    let saved;
    try { saved = JSON.parse(localStorage.getItem('session-chat.request')); } catch { /* No prior submission. */ }
    // Media is not stored in the browser; its signature is enough to detect a changed submission.
    const signature = media.map(item => `${item.media_type}:${item.data.length}`).join(',');
    const body = saved?.session === session && saved.message === message && saved.signature === signature
        ? { session, request_id: saved.request_id, message, attachments: media }
        : { session, request_id: crypto.randomUUID(), message, attachments: media };
    localStorage.setItem('session-chat.request', JSON.stringify({
        session, request_id: body.request_id, message, signature
    }));
    await action(async () => {
        const ack = await request(`${path()}/turns`, body);
        $('prompt').value = ''; clearAttachments(); localStorage.removeItem('session-chat.request'); return ack;
    });
};
$('input-mode').onchange = render;
// Mouse clicks open the picker through the label's native for="media" activation;
// this handler only adds keyboard support for the focusable label.
$('pick-media').onkeydown = event => {
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); $('media').click();
    }
};
$('media').onchange = event => { addFiles([...event.target.files]); event.target.value = ''; };
$('prompt').oninput = syncSend;
$('prompt').onpaste = event => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) { event.preventDefault(); addFiles(files); }
};
$('prompt').onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault(); if (!$('send').disabled) $('compose').requestSubmit();
    }
};
$('connect').onclick = async () => {
    connected = !connected;
    $('connect').textContent = connected ? '断开事件连接' : '重新连接并补历史';
    if (connected) await connect().catch(notice);
    else {
        source?.close(); source = undefined;
        clearTimeout(reloadTimer); reloadTimer = undefined; refreshAgain = false;
        $('connection').textContent = '已断开，后台继续执行';
    }
};
$('new-session').onclick = () => select(crypto.randomUUID()).catch(notice);
$('sessions').onchange = () => select($('sessions').value).catch(notice);
$('interrupt').onclick = () => action(() => request(`${path()}/interrupt`, { run_id: (pendingRun || snapshot?.turns.at(-1)).runId }));
$('resume').onclick = () => action(() => request(`${path()}/turns/${snapshot.turns.at(-1).turnId}/resume`, {}));
$('close-detail').onclick = () => $('detail').close();
// Programmatic value assignment fires no input event; sync the send button manually.
for (const button of document.querySelectorAll('[data-prompt]'))
    button.onclick = () => { $('prompt').value = button.dataset.prompt; $('prompt').focus(); syncSend(); };
// Inbox acceptance can change the queue without advancing the execution-event cursor.
setInterval(() => { if (connected && !document.hidden) scheduleSnapshot(); }, 2000);
await select(session).catch(notice);
