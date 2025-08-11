import React, { useEffect, useState } from 'react'

// ================== 설정 ==================
const GOOGLE_CLIENT_ID = "799750041217-b33n0j95oc9lap4es9sruc0amr8lfurc.apps.googleusercontent.com"; // e.g. 1234567890-abc123.apps.googleusercontent.com
const YT_API_KEY = "AIzaSyCA8YsHT5RiM1Nrne-RftTAVOkXUJIBNRs";
const SCOPES = "https://www.googleapis.com/auth/youtube.readonly"
// ========================================

// 외부 스크립트 로더
function useScript(src) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const el = document.createElement('script')
    el.src = src
    el.async = true
    el.onload = () => setReady(true)
    el.onerror = () => setReady(false)
    document.body.appendChild(el)
    return () => document.body.removeChild(el)
  }, [src])
  return ready
}

// ISO8601 PT#M#S → seconds
function durationToSeconds(iso) {
  if (!iso || typeof iso !== 'string') return 0
  const r = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/
  const m = iso.match(r)
  if (!m) return 0
  const h = parseInt(m[1] || '0', 10)
  const min = parseInt(m[2] || '0', 10)
  const s = parseInt(m[3] || '0', 10)
  return h * 3600 + min * 60 + s
}

function isShorts({ title, durationISO }) {
  const secs = durationToSeconds(durationISO)
  if (secs > 0 && secs < 60) return true
  if ((title || '').toLowerCase().includes('#shorts')) return true
  return false
}

export default function App() {
  const gapiReady = useScript('https://apis.google.com/js/api.js')

  const [authReady, setAuthReady] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [feed, setFeed] = useState([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [activeVideoId, setActiveVideoId] = useState('')

  const hasRealKeys =
    GOOGLE_CLIENT_ID && GOOGLE_CLIENT_ID !== 'temp' &&
    YT_API_KEY && YT_API_KEY !== 'temp'

  // gapi 초기화
  useEffect(() => {
    if (!gapiReady) return
    if (!hasRealKeys) return
    const g = window.gapi
    if (!g) return
    g.load('client:auth2', async () => {
      try {
        await g.client.init({
          apiKey: YT_API_KEY,
          clientId: GOOGLE_CLIENT_ID,
          discoveryDocs: [
            'https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest',
          ],
          scope: SCOPES,
        })
        const auth = g.auth2.getAuthInstance()
        setAuthReady(true)
        setSignedIn(auth.isSignedIn.get())
        auth.isSignedIn.listen((val) => setSignedIn(val))
      } catch (e) {
        console.error('gapi init error:', e)
        const msg =
          (e && e.result && e.result.error && e.result.error.message) ||
          e?.error || e?.details || e?.message ||
          (typeof e === 'string' ? e : JSON.stringify(e))
        setError('Google API 초기화 실패: ' + msg)
      }
    })
  }, [gapiReady, hasRealKeys])

  // 로그인/로그아웃
  const handleSignIn = async () => {
    const g = window.gapi
    if (!g || !authReady) return
    try {
      await g.auth2.getAuthInstance().signIn()
    } catch (e) {
      console.error('signin error:', e)
      setError('로그인 실패: ' + (e?.error || e?.message || '알 수 없는 오류'))
    }
  }

  const handleSignOut = async () => {
    const g = window.gapi
    if (!g || !authReady) return
    try {
      await g.auth2.getAuthInstance().signOut()
      setFeed([])
      setResults([])
      setActiveVideoId('')
    } catch (e) {
      console.error('signout error:', e)
    }
  }

  // 로그인 시 구독 채널 기반 피드 생성
  useEffect(() => {
    if (!signedIn) return
    ;(async () => {
      setLoading(true)
      setError('')
      try {
        const g = window.gapi
        const subsRes = await g.client.youtube.subscriptions.list({
          mine: true,
          part: 'snippet,contentDetails',
          maxResults: 50,
          order: 'relevance',
        })
        const channels = (subsRes.result.items || []).map(
          (s) => s.snippet.resourceId.channelId
        )
        if (channels.length === 0) {
          setFeed([])
          setLoading(false)
          return
        }
        const videoIds = new Set()
        for (const ch of channels) {
          const searchRes = await g.client.youtube.search.list({
            part: 'snippet',
            channelId: ch,
            maxResults: 10,
            order: 'date',
            type: 'video',
            safeSearch: 'none',
          })
          ;(searchRes.result.items || []).forEach((it) => {
            const vid = it.id?.videoId
            if (vid) videoIds.add(vid)
          })
        }
        const ids = Array.from(videoIds)
        const chunks = []
        for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50))
        const collected = []
        for (const chunk of chunks) {
          const vRes = await g.client.youtube.videos.list({
            part: 'snippet,contentDetails',
            id: chunk.join(','),
          })
          ;(vRes.result.items || []).forEach((v) => {
            const { title, channelTitle, publishedAt, thumbnails } = v.snippet || {}
            const durationISO = v.contentDetails?.duration
            if (isShorts({ title, durationISO })) return
            collected.push({
              id: v.id,
              title,
              channelTitle,
              publishedAt,
              thumb: thumbnails?.medium?.url || thumbnails?.default?.url,
              duration: durationISO,
            })
          })
        }
        collected.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
        setFeed(collected)
      } catch (e) {
        console.error('feed error:', e)
        setError('피드 로딩 실패: ' + (e?.error || e?.message || '알 수 없는 오류'))
      } finally {
        setLoading(false)
      }
    })()
  }, [signedIn])

  // 검색
  const handleSearch = async (e) => {
    e?.preventDefault?.()
    if (!query.trim()) return
    setLoading(true)
    setError('')
    try {
      const g = window.gapi
      const sRes = await g.client.youtube.search.list({
        part: 'snippet',
        q: query,
        maxResults: 25,
        type: 'video',
        safeSearch: 'none',
      })
      const ids = (sRes.result.items || [])
        .map((i) => i.id?.videoId)
        .filter(Boolean)
      const vRes = await g.client.youtube.videos.list({
        part: 'snippet,contentDetails',
        id: ids.join(','),
      })
      const rows = (vRes.result.items || [])
        .map((v) => {
          const { title, channelTitle, publishedAt, thumbnails } = v.snippet || {}
          const durationISO = v.contentDetails?.duration
          return {
            id: v.id,
            title,
            channelTitle,
            publishedAt,
            thumb: thumbnails?.medium?.url || thumbnails?.default?.url,
            duration: durationISO,
          }
        })
        .filter((row) => !isShorts({ title: row.title, durationISO: row.duration }))
      rows.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      setResults(rows)
    } catch (e) {
      console.error('search error:', e)
      setError('검색 실패: ' + (e?.error || e?.message || '알 수 없는 오류'))
    } finally {
      setLoading(false)
    }
  }

  const VideoCard = ({ v, onPlay }) => (
    <div className="group flex gap-3 rounded-2xl p-3 shadow hover:shadow-md transition bg-white/70 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800">
      <button onClick={() => onPlay(v.id)} className="shrink-0 relative rounded-xl overflow-hidden">
        {v.thumb ? (
          <img src={v.thumb} alt={v.title} className="h-28 w-48 object-cover" loading="lazy" />
        ) : (
          <div className="h-28 w-48 bg-zinc-200 dark:bg-zinc-800" />
        )}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/30">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-10 h-10 text-white">
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
      </button>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="text-sm text-zinc-500 dark:text-zinc-400">{new Date(v.publishedAt).toLocaleString()}</div>
        <div className="font-medium leading-snug line-clamp-2">{v.title}</div>
        <div className="text-sm text-zinc-600 dark:text-zinc-300">{v.channelTitle}</div>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-50 to-white dark:from-zinc-950 dark:to-zinc-900 text-zinc-900 dark:text-zinc-50">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">나만의 YouTube 피드 (쇼츠/조회수/댓글 숨김)</h1>
          <div className="flex items-center gap-2">
            {!signedIn ? (
              <button onClick={handleSignIn} disabled={!authReady || !hasRealKeys} className="rounded-xl px-4 py-2 shadow border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50">
                Google 계정으로 로그인
              </button>
            ) : (
              <button onClick={handleSignOut} className="rounded-xl px-4 py-2 shadow border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                로그아웃
              </button>
            )}
          </div>
        </header>

        <form onSubmit={handleSearch} className="mt-6">
          <div className="flex gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="동영상 검색 (쇼츠 자동 제외)"
              className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
            <button type="submit" className="rounded-xl px-4 py-3 shadow border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              검색
            </button>
          </div>
        </form>

        {loading && <div className="mt-4 text-sm text-zinc-500">불러오는 중…</div>}
        {error && <div className="mt-4 text-sm text-red-500 break-words whitespace-pre-wrap">{error}</div>}

        {activeVideoId && (
          <div className="mt-6 rounded-2xl overflow-hidden border border-zinc-200 dark:border-zinc-800 shadow">
            <div className="aspect-video w-full">
              <iframe
                className="h-full w-full"
                src={`https://www.youtube.com/embed/${activeVideoId}?modestbranding=1&rel=0&iv_load_policy=3`}
                title="YouTube video player"
                frameBorder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
              />
            </div>
          </div>
        )}

        {results.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-3 text-xl font-semibold">검색 결과</h2>
            <div className="grid gap-3">
              {results.map((v) => (
                <VideoCard key={`s_${v.id}`} v={v} onPlay={setActiveVideoId} />
              ))}
            </div>
          </section>
        )}

        <section className="mt-10">
          <div className="mb-3 flex items-end justify-between">
            <h2 className="text-xl font-semibold">내 구독 기반 최신 영상</h2>
            <p className="text-sm text-zinc-500">홈 추천을 완벽히 복제할 수는 없어 구독 채널 최신 업로드로 대체합니다.</p>
          </div>
          {signedIn ? (
            <div className="grid gap-3">
              {feed.map((v) => (
                <VideoCard key={v.id} v={v} onPlay={setActiveVideoId} />
              ))}
              {feed.length === 0 && !loading && (
                <div className="text-sm text-zinc-500">표시할 영상이 없어요. 구독 채널 업로드가 없거나 모두 쇼츠로 분류되었을 수 있어요.</div>
              )}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-6 text-zinc-600 dark:text-zinc-300">
              로그인하면 구독 채널을 기반으로 개인 피드를 생성해드려요.
            </div>
          )}
        </section>

        <footer className="mt-12 pb-8 text-xs text-zinc-500">
          <p>* 이 프로젝트는 YouTube Data API v3를 사용하며, 이용약관 및 API 정책을 준수해야 합니다. 댓글/조회수는 의도적으로 렌더링하지 않습니다.</p>
        </footer>
      </div>
    </div>
  )
}
