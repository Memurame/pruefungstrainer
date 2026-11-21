// Markdown mit Tabellen, sichtbaren Zeilenumbrüchen, <br> in Zellen und Formeln ($…$).

import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { prepareMarkdown } from '../../shared/logic'

const remarkPlugins = [remarkGfm, remarkBreaks, remarkMath]
// Erst rohes HTML zulassen und bereinigen, danach Formeln setzen
const rehypePlugins = [rehypeRaw, rehypeSanitize, rehypeKatex]

export const Markdown = memo(function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
        {prepareMarkdown(text)}
      </ReactMarkdown>
    </div>
  )
})
