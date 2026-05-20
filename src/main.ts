import './style.css'
import { FusionText } from './FusionText'

async function boot() {
  await document.fonts.load("900 120px 'Bebas Neue'")
  await new Promise<void>(r => setTimeout(r, 60))

  const canvas = document.getElementById('c') as HTMLCanvasElement
  new FusionText(canvas)

  // Hint — fades on first mouse move (FusionText handles opacity)
  const hint = document.createElement('div')
  hint.id          = 'hint'
  hint.textContent = 'hover · scroll · click'
  document.body.appendChild(hint)
}

boot()
