export type IntroTocItem = {
  id: string
  title: string
  level: number
}

function slugify(title: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'section'
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 从 Markdown 提取 h1~h3 标题作为左侧导航 */
export function parseIntroToc(markdown: string): IntroTocItem[] {
  const items: IntroTocItem[] = []
  const seen = new Map<string, number>()
  for (const line of markdown.split('\n')) {
    const m = /^(#{1,3})\s+(.+)$/.exec(line.trim())
    if (!m) continue
    const level = m[1].length
    const title = m[2].trim()
    let id = slugify(title)
    const n = (seen.get(id) ?? 0) + 1
    seen.set(id, n)
    if (n > 1) id = `${id}-${n}`
    items.push({ id, title, level })
  }
  return items
}

/** 轻量 Markdown → HTML（用户手册级，无第三方依赖） */
export function renderIntroMarkdownHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inCode = false
  let codeLang = ''
  let inUl = false
  let inOl = false
  let inTable = false
  let tableHeadDone = false
  const slugCounts = new Map<string, number>()

  const headingId = (title: string) => {
    let id = slugify(title)
    const n = (slugCounts.get(id) ?? 0) + 1
    slugCounts.set(id, n)
    if (n > 1) id = `${id}-${n}`
    return id
  }

  const closeLists = () => {
    if (inUl) {
      out.push('</ul>')
      inUl = false
    }
    if (inOl) {
      out.push('</ol>')
      inOl = false
    }
  }

  const closeTable = () => {
    if (inTable) {
      out.push('</tbody></table>')
      inTable = false
      tableHeadDone = false
    }
  }

  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trimEnd()

    if (line.startsWith('```')) {
      closeLists()
      closeTable()
      if (!inCode) {
        inCode = true
        codeLang = line.slice(3).trim()
        out.push(`<pre class="intro-md-pre"><code class="intro-md-code">${codeLang ? `<!-- ${escapeHtml(codeLang)} -->` : ''}`)
      } else {
        out.push('</code></pre>')
        inCode = false
        codeLang = ''
      }
      continue
    }

    if (inCode) {
      out.push(`${escapeHtml(raw)}\n`)
      continue
    }

    if (line.trim() === '---') {
      closeLists()
      closeTable()
      out.push('<hr class="intro-md-hr" />')
      continue
    }

    const hm = /^(#{1,3})\s+(.+)$/.exec(line.trim())
    if (hm) {
      closeLists()
      closeTable()
      const level = hm[1].length
      const title = hm[2].trim()
      const id = headingId(title)
      out.push(`<h${level} id="${id}" class="intro-md-h${level}">${inline(title)}</h${level}>`)
      continue
    }

    const tm = /^\|(.+)\|$/.exec(line.trim())
    if (tm) {
      closeLists()
      const cells = tm[1].split('|').map((c) => c.trim())
      if (cells.every((c) => /^:?-+:?$/.test(c))) {
        continue
      }
      if (!inTable) {
        out.push('<table class="intro-md-table"><thead><tr>')
        for (const c of cells) out.push(`<th>${inline(c)}</th>`)
        out.push('</tr></thead><tbody>')
        inTable = true
        tableHeadDone = true
        continue
      }
      out.push('<tr>')
      for (const c of cells) out.push(`<td>${inline(c)}</td>`)
      out.push('</tr>')
      continue
    } else if (inTable) {
      closeTable()
    }

    const ulm = /^[-*]\s+(.+)$/.exec(line.trim())
    if (ulm) {
      closeTable()
      if (!inUl) {
        closeLists()
        out.push('<ul class="intro-md-ul">')
        inUl = true
      }
      out.push(`<li>${inline(ulm[1])}</li>`)
      continue
    }

    const olm = /^\d+\.\s+(.+)$/.exec(line.trim())
    if (olm) {
      closeTable()
      if (!inOl) {
        closeLists()
        out.push('<ol class="intro-md-ol">')
        inOl = true
      }
      out.push(`<li>${inline(olm[1])}</li>`)
      continue
    }

    const bqm = /^>\s?(.*)$/.exec(line.trim())
    if (bqm) {
      closeLists()
      closeTable()
      out.push(`<blockquote class="intro-md-quote">${inline(bqm[1])}</blockquote>`)
      continue
    }

    if (!line.trim()) {
      closeLists()
      closeTable()
      continue
    }

    closeLists()
    closeTable()
    out.push(`<p class="intro-md-p">${inline(line.trim())}</p>`)
  }

  closeLists()
  closeTable()
  if (inCode) out.push('</code></pre>')

  return out.join('\n')
}
