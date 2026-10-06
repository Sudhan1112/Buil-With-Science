// The community hub: one shared feed, and each client's own private thread with their coach.
//
// The two are the same thing with a different `visibility`, which is deliberate — it means a
// client never has to find a separate screen to ask something they would rather not ask in
// front of everyone, and the coach answers both in one place. The server decides who sees what
// (`canSee` in api/server.js); nothing here is load-bearing for that, and the filters below can
// only narrow a list the server already allowed.
//
// Photos go up before the post does: ingest → local store → PUT /api/media/{hash} → POST the
// hashes. The background media sync cannot carry these, because it works from what the synced
// document references and a community post is not in the document.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api, apiUpload } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { fmtWhen } from '../lib/audit.js'
import { mediaStore } from '../lib/media-store.js'
import { limitsFrom } from '../lib/media-limits.js'
import { mediaErrorText } from '../components/CustomMediaField.jsx'
import { confirmSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Button, Segmented } from '../components/ui.jsx'

const toast = m => useUI.getState().toast(m)
const MAX_IMAGES = 4

function Avatar({ author }) {
  const initial = (author?.name || '?').trim().charAt(0).toUpperCase()
  return <span className="lrow-i" style={{ background: author?.coach ? 'var(--acc)' : 'var(--surface-3)', fontWeight: 600 }}>
    {author?.coach ? <Icon name="shield" /> : initial}
  </span>
}

function Byline({ author, created }) {
  return <div className="row" style={{ gap: 8, minWidth: 0 }}>
    <Avatar author={author} />
    <div style={{ minWidth: 0 }}>
      <div className="tt" style={{ fontSize: 14 }}>
        {author?.gone ? t('A former member') : author?.name}
        {/* The coach's words carry weight the rest of the feed does not, so they are marked
            wherever they appear — a post, a reply, anywhere. */}
        {author?.coach && <span className="tag acc" style={{ marginInlineStart: 6 }}>{t('Coach')}</span>}
      </div>
      <div className="ss">{fmtWhen(Date.parse(created))}</div>
    </div>
  </div>
}

/* An attached photo. Fetched with the session the app already has rather than put in an
   `<img src>`: a paired phone authenticates with a bearer token, which an <img> cannot carry,
   and the object URL is revoked when the row goes away so a long feed does not leak them. */
function PostImage({ hash }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let alive = true
    let made = null
    ;(async () => {
      try {
        const local = await mediaStore.get(hash)
        const blob = local?.blob || await (await import('../lib/api.js')).apiBlob('/api/community/media/' + hash)
        if (!alive) return
        made = URL.createObjectURL(blob)
        setUrl(made)
      } catch { /* swept, or not ours to see — the gap says it better than an error would */ }
    })()
    return () => { alive = false; if (made) URL.revokeObjectURL(made) }
  }, [hash])
  if (!url) return <div style={{ aspectRatio: '1', borderRadius: 12, background: 'var(--surface-3)' }} />
  return <img src={url} alt="" style={{ width: '100%', borderRadius: 12, display: 'block' }} />
}

function Replies({ post, onChanged }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async () => {
    const body = text.trim()
    if (!body) return
    setBusy(true)
    try { await api('/api/community/reply', { method: 'POST', body: JSON.stringify({ id: post.id, text: body }) }); setText(''); await onChanged() }
    catch (e) { toast(e.message || t('Could not send that — try again')) }
    finally { setBusy(false) }
  }
  const remove = r => confirmSheet({
    title: t('Delete reply?'), confirmText: t('Delete'), danger: true,
    onConfirm: async () => {
      try { await api('/api/community/delete', { method: 'POST', body: JSON.stringify({ id: post.id, replyId: r.id }) }); await onChanged() }
      catch (e) { toast(e.message || t('Could not delete that')) }
    }
  })
  return <div style={{ marginTop: 10, borderTop: '1px solid var(--sep)', paddingTop: 10 }}>
    {post.replies.map(r => <div key={r.id} className="row between" style={{ gap: 8, marginBottom: 8, alignItems: 'flex-start' }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <Byline author={r.author} created={r.created} />
        <div className="small" style={{ marginTop: 4, marginInlineStart: 42, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{r.text}</div>
      </div>
      {r.canDelete && <button className="iconbtn sm" aria-label={t('Delete')} onClick={() => remove(r)}><Icon name="trash" /></button>}
    </div>)}
    <div className="row" style={{ gap: 8 }}>
      <input className="input" value={text} maxLength={2000} placeholder={t('Write a reply…')}
        onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') send() }} />
      <Button size="sm" variant="tinted" icon="rocket" disabled={busy || !text.trim()} onClick={send}>{t('Send')}</Button>
    </div>
  </div>
}

function Post({ post, onChanged }) {
  const [open, setOpen] = useState(false)
  const remove = () => confirmSheet({
    title: t('Delete post?'), message: t('The post and every reply under it will be removed.'),
    confirmText: t('Delete'), danger: true,
    onConfirm: async () => {
      try { await api('/api/community/delete', { method: 'POST', body: JSON.stringify({ id: post.id }) }); await onChanged() }
      catch (e) { toast(e.message || t('Could not delete that')) }
    }
  })
  return <div className="card">
    <div className="row between" style={{ alignItems: 'flex-start' }}>
      <Byline author={post.author} created={post.created} />
      <div className="row" style={{ gap: 6 }}>
        {post.visibility === 'private' && <span className="tag" title={t('Only you and your coach can see this')}><Icon name="lock" /> {t('Private')}</span>}
        {post.canDelete && <button className="iconbtn sm" aria-label={t('Delete')} onClick={remove}><Icon name="trash" /></button>}
      </div>
    </div>
    {!!post.text && <div style={{ marginTop: 10, whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{post.text}</div>}
    {post.images.length > 0 && <div style={{ marginTop: 10, display: 'grid', gap: 8,
      gridTemplateColumns: post.images.length === 1 ? '1fr' : '1fr 1fr' }}>
      {post.images.map(h => <PostImage key={h} hash={h} />)}
    </div>}
    <div className="row" style={{ marginTop: 10 }}>
      <Button size="sm" variant="ghost" className="dim" icon="envelope" onClick={() => setOpen(o => !o)}>
        {post.replies.length ? t('{0} replies', post.replies.length) : t('Reply')}
      </Button>
    </div>
    {open && <Replies post={post} onChanged={onChanged} />}
  </div>
}

function Composer({ onPosted }) {
  const config = useStore(s => s.config)
  const [text, setText] = useState('')
  const [visibility, setVisibility] = useState('public')
  const [drafts, setDrafts] = useState([])   // { hash, blob, mime }
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)

  // The drafts are in the local store and nothing references them yet, so the hourly local
  // clean-up would be within its rights to take one out of a composer left open. The hold is
  // released when the composer goes away or the draft list changes.
  useEffect(() => mediaStore.hold(drafts.map(d => d.hash)), [drafts])

  const onFile = async ev => {
    const file = ev.target.files && ev.target.files[0]
    ev.target.value = ''
    if (!file) return
    if (drafts.length >= MAX_IMAGES) { toast(t('Up to {0} photos on a post.', MAX_IMAGES)); return }
    setBusy(true)
    try {
      const { ingestMediaFile } = await import('../lib/media-ingest.js')
      const out = await ingestMediaFile(file, { ...limitsFrom(config), video: false })
      const main = out.blobs.find(b => b.hash === out.media.hash) || out.blobs[0]
      for (const b of out.blobs) await mediaStore.put(b.hash, b.blob, { mime: b.mime, pending: true })
      setDrafts(d => [...d, { hash: main.hash, blob: main.blob, mime: main.mime }])
    } catch (e) { toast(mediaErrorText(e)) }
    finally { setBusy(false) }
  }

  const post = async () => {
    const body = text.trim()
    if (!body && !drafts.length) { toast(t('Say something, or add a photo')); return }
    setBusy(true)
    try {
      // Every photo goes up before the post that names it. A failed upload stops the whole
      // thing rather than publishing a post with a gap where a picture should be.
      for (const d of drafts) await apiUpload('/api/media/' + d.hash, d.blob, d.mime)
      await api('/api/community', { method: 'POST', body: JSON.stringify({ text: body, visibility, images: drafts.map(d => d.hash) }) })
      setText(''); setDrafts([])
      await onPosted()
    } catch (e) { toast(e.message || t('Could not post that — try again')) }
    finally { setBusy(false) }
  }

  return <div className="card">
    <textarea className="input" rows={3} maxLength={4000} value={text} onChange={e => setText(e.target.value)}
      placeholder={visibility === 'private' ? t('Ask your coach something — only they will see it') : t('Share how it is going…')} />
    {drafts.length > 0 && <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {drafts.map(d => <div key={d.hash} style={{ position: 'relative' }}>
        <img src={URL.createObjectURL(d.blob)} alt="" width={64} height={64} style={{ borderRadius: 10, objectFit: 'cover', display: 'block' }} />
        <button className="iconbtn sm" aria-label={t('Remove')} style={{ position: 'absolute', top: -6, insetInlineEnd: -6 }}
          onClick={() => setDrafts(x => x.filter(y => y.hash !== d.hash))}><Icon name="xmark" /></button>
      </div>)}
    </div>}
    <div style={{ height: 10 }} />
    {/* Public is the default because the hub is worth having only if people post in it; the
        private option is right next to it so asking the coach alone is never a detour. */}
    <Segmented value={visibility} onChange={setVisibility} options={[
      { value: 'public', label: t('Everyone'), icon: 'globe' },
      { value: 'private', label: t('Only my coach'), icon: 'lock' },
    ]} />
    <div style={{ height: 10 }} />
    <div className="row" style={{ gap: 8 }}>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFile} />
      <Button size="sm" icon="image" disabled={busy || drafts.length >= MAX_IMAGES} onClick={() => fileRef.current?.click()}>{t('Photo')}</Button>
      <Button size="sm" variant="primary" icon="rocket" disabled={busy} onClick={post}>{busy ? t('Posting…') : t('Post')}</Button>
    </div>
  </div>
}

export default function Community() {
  const [scope, setScope] = useState('all')
  const [posts, setPosts] = useState(null)   // null until the first answer; [] is a real empty feed
  const [error, setError] = useState(null)

  const load = useCallback(async (which = scope) => {
    try {
      const r = await api('/api/community?scope=' + which)
      setPosts(r.posts)
      setError(null)
    } catch (e) { setError(e.message || t('Could not load the community')) }
  }, [scope])

  useEffect(() => { load(scope) }, [load, scope])

  return <div className="narrow">
    <div className="hdr">
      <div><h1>{t('Community')}</h1><div className="sub">{t('Share how it is going, and ask your coach')}</div></div>
    </div>

    <Composer onPosted={() => load(scope)} />
    <div style={{ height: 12 }} />
    <Segmented value={scope} onChange={setScope} options={[
      { value: 'all', label: t('All') },
      { value: 'mine', label: t('Mine') },
      { value: 'private', label: t('With my coach') },
    ]} />
    <div style={{ height: 12 }} />

    {error ? <div className="empty"><div className="ico"><Icon name="warning" /></div>{error}</div>
      : posts === null ? <div className="empty"><div className="ico"><Icon name="cloud" /></div>{t('Loading…')}</div>
        : posts.length === 0 ? <div className="empty"><div className="ico"><Icon name="personCircle" /></div>
          {scope === 'all' ? t('Nothing here yet — be the first to post.') : t('Nothing here yet.')}</div>
          : posts.map(p => <Post key={p.id} post={p} onChanged={() => load(scope)} />)}
  </div>
}
