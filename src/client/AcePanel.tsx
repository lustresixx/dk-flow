/**
 * The workbench launcher: a floating button (with the ACE logo) that opens
 * the full-page workflow workbench.
 */
import { useState } from 'react'
import { Workbench } from './Workbench.tsx'
import styles from './AcePanel.module.css'

const LOGO = '/plugins/dsh-ace-harness/assets/ace-logo.png'

export interface AcePanelProps {
  currentSessionId: () => string | undefined
  send: (text: string) => Promise<boolean>
}

export function AcePanel(props: AcePanelProps): JSX.Element {
  const [open, setOpen] = useState(false)
  void props.currentSessionId
  if (open) {
    return <Workbench send={props.send} onClose={() => { setOpen(false) }} />
  }
  return (
    <button type="button" className={styles.launcher} onClick={() => { setOpen(true) }}>
      <img src={LOGO} alt="" className={styles.launcherLogo} />
      <span>工作流</span>
    </button>
  )
}
