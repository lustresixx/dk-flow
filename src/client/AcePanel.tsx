/**
 * The workbench launcher plus the live run sidebar: a floating button (with
 * the ACE logo) opens the full-page workbench, while the live panel appears
 * automatically on the right while a workflow is running.
 */
import { useState } from 'react'
import { LiveRunPanel } from './LiveRunPanel.tsx'
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
  return (
    <>
      <LiveRunPanel />
      {open ? (
        <Workbench send={props.send} onClose={() => { setOpen(false) }} />
      ) : (
        <button type="button" className={styles.launcher} onClick={() => { setOpen(true) }}>
          <img src={LOGO} alt="" className={styles.launcherLogo} />
          <span>工作流</span>
        </button>
      )}
    </>
  )
}
