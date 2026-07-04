import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { $createParagraphNode, $getRoot, $getSelection, $isRangeSelection, FORMAT_ELEMENT_COMMAND, FORMAT_TEXT_COMMAND, REDO_COMMAND, UNDO_COMMAND } from 'lexical'
import { $generateHtmlFromNodes, $generateNodesFromDOM } from '@lexical/html'
import { $patchStyleText } from '@lexical/selection'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { ListItemNode, ListNode, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND } from '@lexical/list'
import { LinkNode, TOGGLE_LINK_COMMAND } from '@lexical/link'
import { apiFetch } from '../../lib/api'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useToast } from '../../contexts/ToastContext'
import { useAuth } from '../../contexts/AuthContext'

function MailIcon({ className = 'w-4 h-4' }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M3 8l8.2 5.47a1.5 1.5 0 001.6 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  )
}

function MenuIcon({ type, filled }) {
  const paths = {
    all: 'M4 6h16M4 12h16M4 18h16',
    star: 'M11.48 3.5l2.12 4.3 4.74.69-3.43 3.34.81 4.72-4.24-2.23-4.24 2.23.81-4.72-3.43-3.34 4.74-.69 2.12-4.3z',
    draft: 'M5 4h9l5 5v11H5V4zM14 4v5h5M8 14h8M8 17h5',
    search: 'M11 5a6 6 0 104.24 10.24L20 20',
    sent: 'M4 12l16-8-5 16-3-7-8-1z',
    trash: 'M6 7h12M10 7V5h4v2m-6 0l1 13h6l1-13',
    todo: 'M5 13l4 4L19 7',
    inbox: 'M4 5h16v11l-3 3H7l-3-3V5zM4 14h5l1.5 2h3L15 14h5',
    folder: 'M3 6h7l2 2h9v10a2 2 0 01-2 2H5a2 2 0 01-2-2V6z',
    back: 'M15 6l-6 6 6 6',
    refresh: 'M4 4v6h6M20 20v-6h-6M5 15a7 7 0 0011.9 3.9M19 9A7 7 0 007.1 5.1',
    settings: 'M12 8a4 4 0 100 8 4 4 0 000-8zM4 12h2m12 0h2M12 4v2m0 12v2m-5.66-13.66l1.42 1.42m8.48 8.48l1.42 1.42m0-11.32l-1.42 1.42m-8.48 8.48l-1.42 1.42',
    reply: 'M9 14l-5-5 5-5v3h6a5 5 0 015 5v2',
    forward: 'M15 14l5-5-5-5v3H9a5 5 0 00-5 5v2',
    archive: 'M4 7h16M5 7l1 13h12l1-13M9 11h6',
    ai: 'M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.4 6.4L22 12l-6.6 2.6L13 21l-2.4-6.4L4 12l6.6-2.6L13 3z',
    chevronRight: 'M9 5l7 7-7 7',
    chevronDown: 'M6 9l6 6 6-6',
    tag: 'M3 7l0 5.17a2 2 0 00.59 1.42l6.83 6.83a2 2 0 002.82 0l4.17-4.17a2 2 0 000-2.82L10.58 6.6A2 2 0 009.17 6L4 6a1 1 0 00-1 1zM7 10h.01',
  }

  // 폴더 아이콘에 색상이 지정되면 내부까지 같은 색(currentColor)으로 채운다.
  const fillFolder = filled && type === 'folder'
  return (
    <svg className="w-4 h-4 flex-shrink-0" fill={fillFolder ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={paths[type] || paths.folder} />
    </svg>
  )
}

function ToolbarButton({ icon, label, primary = false, onClick, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-bold transition-all ${
        primary
          ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200 hover:bg-indigo-500'
          : 'border border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900'
      } disabled:cursor-not-allowed disabled:opacity-60`}
    >
      <MenuIcon type={icon} />
      <span>{label}</span>
    </button>
  )
}

const MAIL_PAGE_SIZE = 100
const FOLDER_SYNC_COOLDOWN_MS = 30 * 1000
const UNIFIED_KEY_PREFIX = 'unified:'
const SMART_KEY_PREFIX = 'smart:'
const SMART_SEED_STORAGE_KEY = 'mail-smart-folder-seeded-v1'
const UNIFIED_FOLDER_COLOR_STORAGE_KEY = 'mail-unified-folder-colors-v1'
const DEFAULT_MAILCLAW_TRASH_RULE_NAME = 'MailClaw 휴지통 이동'

// 첨부 정책(MailService.md 10.8/10.9). 서버 로드 실패 시 대비 기본값(합계 20MB 안전선).
const DEFAULT_ATTACH_POLICY = {
  maxFileMb: 20,
  maxTotalMb: 20,
  maxFiles: 20,
  blockedExtensions: ['exe', 'bat', 'cmd', 'com', 'scr', 'pif', 'js', 'vbs', 'jar', 'msi', 'cpl', 'dll'],
}

function normalizeAttachPolicy(p = {}) {
  return {
    maxFileMb: Number(p.max_file_mb) > 0 ? Math.floor(Number(p.max_file_mb)) : DEFAULT_ATTACH_POLICY.maxFileMb,
    maxTotalMb: Number(p.max_total_mb) > 0 ? Math.floor(Number(p.max_total_mb)) : DEFAULT_ATTACH_POLICY.maxTotalMb,
    maxFiles: Number(p.max_files) > 0 ? Math.floor(Number(p.max_files)) : DEFAULT_ATTACH_POLICY.maxFiles,
    blockedExtensions: Array.isArray(p.blocked_extensions)
      ? p.blocked_extensions.map(e => String(e).toLowerCase().replace(/^\.+/, '')).filter(Boolean)
      : [...DEFAULT_ATTACH_POLICY.blockedExtensions],
  }
}

function fileExtOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

// 컴포즈 첨부 이미지 미리보기(10.10): 브라우저가 <img>로 렌더 가능한 이미지만 썸네일 대상.
// HEIC/HEIF·일부 TIFF는 렌더 불가라 제외하고 일반 칩으로 폴백한다.
const PREVIEWABLE_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico'])
function isPreviewableImageFile(file) {
  const type = String(file?.type || '').toLowerCase()
  if (type.startsWith('image/')) {
    // 브라우저가 못 그리는 이미지 MIME은 제외
    return !/heic|heif|tiff/.test(type)
  }
  // type이 비어 있으면 확장자로 폴백 판정
  return !type && PREVIEWABLE_IMAGE_EXTS.has(fileExtOf(file?.name))
}

const MAIL_TEXT = {
  ko: {
    mail: '메일',
    compose: '메일 쓰기',
    refresh: '새로 고침',
    syncing: '동기화 중',
    searchPlaceholder: '메일 검색...',
    mailList: '메일 목록',
    selectedCount: n => `${n}개 선택됨`,
    count: n => `${n}개`,
    mainMenu: '메인 메뉴로 이동',
    accountSettings: '계정 설정',
    ok: '확인',
    cancel: '취소',
    none: '없음',
    emptyListTitle: '표시할 메일이 없습니다',
    emptyListDesc: label => `${label}에 표시할 메일이 없습니다.`,
    loadingMessages: '메일을 불러오는 중입니다.',
    loadingMore: '더 불러오는 중...',
    selectMailTitle: '메일을 선택하세요',
    selectMailDesc: '선택한 메일의 제목, 보낸 사람, 첨부파일, 본문이 이 영역에 표시됩니다.',
    noSubject: '(제목 없음)',
    noSender: '(보낸 사람 없음)',
    noBody: '본문이 없습니다.',
    from: '보낸 사람',
    to: '받는 사람',
    cc: '참조',
    bcc: '숨은 참조',
    date: '날짜',
    reply: '답장',
    replyAll: '전체 답장',
    forward: '전달',
    sendToAgentic: 'AgenticAI로 보내기',
    summarize: '요약',
    regenerating: '요약 생성 중...',
    regenerate: '요약 다시 생성',
    copySummary: '요약 복사',
    copied: '복사됨',
    copyFailed: '복사에 실패했습니다. 요약 내용을 직접 선택해 복사해주세요.',
    summaryInvalid: '요약 응답 형식이 올바르지 않습니다.',
    summaryFailed: '메일 요약을 생성하지 못했습니다.',
    bodyLoading: '메일 본문을 불러오는 중입니다.',
    attachmentCount: n => `첨부파일 ${n}개`,
    attachmentMark: '첨부파일 있음',
    smartFolders: '스마트 폴더',
    addSmartFolder: '스마트 폴더 추가',
    smartFolderHint: '메일을 여기로 끌어 담으면 계정과 무관하게 모아 볼 수 있어요.',
    folderMissingTitle: '서버에 없는 폴더입니다. 로컬 보관 메일만 표시되며 동기화하지 않습니다.',
    localFolderTitle: '로컬 전용 폴더',
    metaLoading: '메일 계정 정보를 불러오는 중입니다.',
    noAccounts: '연결된 메일 계정이 없습니다.',
    clearSelection: '선택 해제',
    folders: {
      all: '모든 편지함',
      inbox: '받은 편지함',
      starred: '중요 편지함',
      drafts: '임시 보관함',
      search: '검색',
      sent: '보낸 메일',
      trash: '휴지통',
      spam: '스팸 메일함',
    },
    context: {
      delete: '메일 삭제',
      star: '중요 메일로 표시',
      unstar: '중요 메일 표시 해제',
      markUnread: '안읽은 메일로',
      agenticWatch: 'EasyAI가 글타래로 모니터링 하도록 등록',
      registerMailClaw: 'MailClaw에 등록',
      registerMailClawTrash: 'MailClaw 휴지통 이동으로 등록',
      move: '이동',
      noMoveFolders: '이동할 폴더가 없습니다',
    },
    summary: {
      noInfo: '확인된 내용 없음',
      schedule: '일정',
      date: '날짜',
      time: '시간',
      location: '장소',
      participants: '참석 대상',
      notes: '비고',
      keyPoints: '중요 포인트',
      detail: '중요 내용 요약',
      actions: '액션 아이템 / 시간',
      selectDate: '날짜 선택',
      selectTime: '시간 선택',
      allDay: '하루종일',
      savingActionTime: '저장 중',
      calendarAdded: '캘린더 등록됨',
      actionTimeFailed: '액션 아이템 시간을 저장하지 못했습니다.',
    },
    composeView: {
      title: '메일 쓰기',
      cancel: '취소',
      saving: '저장 중',
      draft: '임시 저장',
      sending: '보내는 중',
      send: '보내기',
      fromAccount: '보내는 계정',
      noAccount: '연결된 메일 계정이 없습니다',
      to: '받는 사람',
      cc: '참조',
      bcc: '숨은 참조',
      subject: '제목',
      subjectPlaceholder: '제목을 입력하세요',
      body: '본문',
      attachment: '첨부',
      attachFile: '파일 첨부',
      dropHint: '파일을 이 영역에 끌어다 놓아도 첨부됩니다.',
      needAccount: '보낼 메일 계정을 선택해주세요.',
      needTo: '받는 사람을 입력해주세요.',
      needContent: '제목 또는 본문을 입력해주세요.',
      sent: '메일을 보냈습니다.',
      sendFailed: '메일을 보내지 못했습니다.',
      needDraftAccount: '임시 저장할 메일 계정을 선택해주세요.',
      needDraftContent: '임시 저장할 내용을 입력해주세요.',
      draftSaved: '임시 보관함에 저장했습니다.',
      draftFailed: '임시 저장하지 못했습니다.',
    },
    addressMenu: {
      compose: '메일 작성',
      copy: '주소 복사',
      addContact: '연락처에 추가',
      addVip: 'VIP 목록에 추가',
      search: '해당 주소를 검색',
    },
    folderMenu: {
      add: '폴더 추가',
      addSub: '서브 폴더 추가',
      rename: '이름 변경',
      delete: '폴더 삭제',
      emptyTrash: '휴지통 비우기',
      color: '폴더 색상 설정',
      copyName: '폴더 이름 복사',
      disabledUnified: '통합 폴더는 실제 계정 폴더가 아니라서 이 작업을 직접 적용할 수 없습니다.',
      smartDelete: '스마트 폴더 삭제',
      smartColor: '색상 설정',
      newFolderTitle: '새 폴더',
      newFolderMessage: '새 폴더 이름을 입력하세요.',
      newSubFolderTitle: '서브 폴더',
      newSubFolderMessage: '서브 폴더 이름을 입력하세요.',
      renameFolderTitle: '폴더 이름 변경',
      renameFolderMessage: '폴더의 새 이름을 입력하세요.',
      newSmartFolderTitle: '새 스마트 폴더',
      newSmartFolderMessage: '새 스마트 폴더 이름을 입력하세요.',
      renameSmartFolderTitle: '스마트 폴더 이름 변경',
      renameSmartFolderMessage: '스마트 폴더 이름을 변경합니다.',
    },
    dialogs: {
      emptyTrashTitle: '휴지통 비우기',
      emptyUnifiedTrashTitle: '휴지통 비우기 (모든 계정)',
      emptyTrashMessage: '휴지통에 있는 모든 메일을 영구 삭제합니다.\n\n이 작업은 복구할 수 없습니다.\n\n계속하시겠습니까?',
      emptyUnifiedTrashMessage: n => `모든 계정의 휴지통에 있는 메일을 영구 삭제합니다.${n ? `\n\n대상 계정: ${n}개` : ''}\n\n이 작업은 복구할 수 없습니다.\n\n계속하시겠습니까?`,
    },
    colors: {
      default: '기본값',
      red: '빨강',
      orange: '주황',
      yellow: '노랑',
      green: '녹색',
      blue: '파랑',
      purple: '퍼플',
    },
  },
  en: {
    mail: 'Mail',
    compose: 'Compose',
    refresh: 'Refresh',
    syncing: 'Syncing',
    searchPlaceholder: 'Search mail...',
    mailList: 'Mail list',
    selectedCount: n => `${n} selected`,
    count: n => `${n}`,
    mainMenu: 'Back to main menu',
    accountSettings: 'Account settings',
    ok: 'OK',
    cancel: 'Cancel',
    none: 'None',
    emptyListTitle: 'No mail to display',
    emptyListDesc: label => `No mail to display in ${label}.`,
    loadingMessages: 'Loading mail...',
    loadingMore: 'Loading more...',
    selectMailTitle: 'Select a message',
    selectMailDesc: 'The selected message subject, sender, attachments, and body will appear here.',
    noSubject: '(No subject)',
    noSender: '(No sender)',
    noBody: 'No body content.',
    from: 'From',
    to: 'To',
    cc: 'Cc',
    bcc: 'Bcc',
    date: 'Date',
    reply: 'Reply',
    replyAll: 'Reply all',
    forward: 'Forward',
    sendToAgentic: 'Send to AgenticAI',
    summarize: 'Summarize',
    regenerating: 'Generating summary...',
    regenerate: 'Regenerate summary',
    copySummary: 'Copy summary',
    copied: 'Copied',
    copyFailed: 'Copy failed. Please select and copy the summary manually.',
    summaryInvalid: 'The summary response format is invalid.',
    summaryFailed: 'Failed to generate the mail summary.',
    bodyLoading: 'Loading message body...',
    attachmentCount: n => `${n} attachment${n === 1 ? '' : 's'}`,
    attachmentMark: 'Has attachments',
    smartFolders: 'Smart folders',
    addSmartFolder: 'Add smart folder',
    smartFolderHint: 'Drag mail here to collect it across accounts.',
    folderMissingTitle: 'This folder does not exist on the server. Only local archived mail is shown and it will not sync.',
    localFolderTitle: 'Local-only folder',
    metaLoading: 'Loading mail account information...',
    noAccounts: 'No connected mail accounts.',
    clearSelection: 'Clear selection',
    folders: {
      all: 'All mail',
      inbox: 'Inbox',
      starred: 'Important',
      drafts: 'Drafts',
      search: 'Search',
      sent: 'Sent',
      trash: 'Trash',
      spam: 'Spam',
    },
    context: {
      delete: 'Delete mail',
      star: 'Mark as important',
      unstar: 'Remove important mark',
      markUnread: 'Mark as unread',
      agenticWatch: 'Register thread monitoring with EasyAI',
      registerMailClaw: 'Register in MailClaw',
      registerMailClawTrash: 'Register in MailClaw trash rule',
      move: 'Move',
      noMoveFolders: 'No folders to move to',
    },
    summary: {
      noInfo: 'No confirmed information',
      schedule: 'Schedule',
      date: 'Date',
      time: 'Time',
      location: 'Location',
      participants: 'Participants',
      notes: 'Notes',
      keyPoints: 'Key points',
      detail: 'Summary',
      actions: 'Action items / Time',
      selectDate: 'Select date',
      selectTime: 'Select time',
      allDay: 'All day',
      savingActionTime: 'Saving',
      calendarAdded: 'Added to calendar',
      actionTimeFailed: 'Failed to save the action item time.',
    },
    composeView: {
      title: 'Compose',
      cancel: 'Cancel',
      saving: 'Saving',
      draft: 'Save draft',
      sending: 'Sending',
      send: 'Send',
      fromAccount: 'From account',
      noAccount: 'No connected mail accounts',
      to: 'To',
      cc: 'Cc',
      bcc: 'Bcc',
      subject: 'Subject',
      subjectPlaceholder: 'Enter a subject',
      body: 'Body',
      attachment: 'Attachments',
      attachFile: 'Attach file',
      dropHint: 'You can also drag files into this area.',
      needAccount: 'Please select a sending account.',
      needTo: 'Please enter a recipient.',
      needContent: 'Please enter a subject or body.',
      sent: 'Mail sent.',
      sendFailed: 'Failed to send mail.',
      needDraftAccount: 'Please select an account for the draft.',
      needDraftContent: 'Please enter content to save as a draft.',
      draftSaved: 'Saved to Drafts.',
      draftFailed: 'Failed to save draft.',
    },
    addressMenu: {
      compose: 'Compose mail',
      copy: 'Copy address',
      addContact: 'Add to contacts',
      addVip: 'Add to VIP list',
      search: 'Search this address',
    },
    folderMenu: {
      add: 'Add folder',
      addSub: 'Add subfolder',
      rename: 'Rename',
      delete: 'Delete folder',
      emptyTrash: 'Empty trash',
      color: 'Folder color',
      copyName: 'Copy folder name',
      disabledUnified: 'This is a unified folder, so this action cannot be applied directly.',
      smartDelete: 'Delete smart folder',
      smartColor: 'Color',
      newFolderTitle: 'New folder',
      newFolderMessage: 'Enter a new folder name.',
      newSubFolderTitle: 'Subfolder',
      newSubFolderMessage: 'Enter a subfolder name.',
      renameFolderTitle: 'Rename folder',
      renameFolderMessage: 'Enter a new folder name.',
      newSmartFolderTitle: 'New smart folder',
      newSmartFolderMessage: 'Enter a new smart folder name.',
      renameSmartFolderTitle: 'Rename smart folder',
      renameSmartFolderMessage: 'Enter a new smart folder name.',
    },
    dialogs: {
      emptyTrashTitle: 'Empty trash',
      emptyUnifiedTrashTitle: 'Empty trash (all accounts)',
      emptyTrashMessage: 'Permanently delete all mail in Trash.\n\nThis action cannot be undone.\n\nContinue?',
      emptyUnifiedTrashMessage: n => `Permanently delete mail in Trash for all accounts.${n ? `\n\nTarget accounts: ${n}` : ''}\n\nThis action cannot be undone.\n\nContinue?`,
    },
    colors: {
      default: 'Default',
      red: 'Red',
      orange: 'Orange',
      yellow: 'Yellow',
      green: 'Green',
      blue: 'Blue',
      purple: 'Purple',
    },
  },
  ja: {
    mail: 'メール',
    compose: 'メール作成',
    refresh: '更新',
    syncing: '同期中',
    searchPlaceholder: 'メール検索...',
    mailList: 'メール一覧',
    selectedCount: n => `${n}件選択中`,
    count: n => `${n}件`,
    mainMenu: 'メインメニューへ戻る',
    accountSettings: 'アカウント設定',
    ok: '確認',
    cancel: 'キャンセル',
    none: 'なし',
    emptyListTitle: '表示するメールがありません',
    emptyListDesc: label => `${label}に表示するメールがありません。`,
    loadingMessages: 'メールを読み込んでいます。',
    loadingMore: 'さらに読み込み中...',
    selectMailTitle: 'メールを選択してください',
    selectMailDesc: '選択したメールの件名、差出人、添付ファイル、本文がここに表示されます。',
    noSubject: '(件名なし)',
    noSender: '(差出人なし)',
    noBody: '本文がありません。',
    from: '差出人',
    to: '宛先',
    cc: 'Cc',
    bcc: 'Bcc',
    date: '日付',
    reply: '返信',
    replyAll: '全員に返信',
    forward: '転送',
    sendToAgentic: 'AgenticAIへ送信',
    summarize: '要約',
    regenerating: '要約生成中...',
    regenerate: '要約を再生成',
    copySummary: '要約をコピー',
    copied: 'コピー済み',
    copyFailed: 'コピーに失敗しました。要約を選択して手動でコピーしてください。',
    summaryInvalid: '要約レスポンスの形式が正しくありません。',
    summaryFailed: 'メール要約を生成できませんでした。',
    bodyLoading: 'メール本文を読み込んでいます。',
    attachmentCount: n => `添付ファイル ${n}件`,
    attachmentMark: '添付ファイルあり',
    smartFolders: 'スマートフォルダ',
    addSmartFolder: 'スマートフォルダ追加',
    smartFolderHint: 'ここにメールをドラッグすると、アカウントに関係なくまとめて表示できます。',
    folderMissingTitle: 'サーバーに存在しないフォルダです。ローカル保管メールのみ表示され、同期されません。',
    localFolderTitle: 'ローカル専用フォルダ',
    metaLoading: 'メールアカウント情報を読み込んでいます。',
    noAccounts: '接続済みのメールアカウントがありません。',
    clearSelection: '選択解除',
    folders: {
      all: 'すべてのメール',
      inbox: '受信トレイ',
      starred: '重要メール',
      drafts: '下書き',
      search: '検索',
      sent: '送信済み',
      trash: 'ゴミ箱',
      spam: '迷惑メール',
    },
    context: {
      delete: 'メール削除',
      star: '重要メールにする',
      unstar: '重要メールを解除',
      markUnread: '未読にする',
      agenticWatch: 'EasyAIでスレッド監視を登録',
      registerMailClaw: 'MailClawに登録',
      registerMailClawTrash: 'MailClawゴミ箱移動に登録',
      move: '移動',
      noMoveFolders: '移動先フォルダがありません',
    },
    summary: {
      noInfo: '確認できる内容なし',
      schedule: '日程',
      date: '日付',
      time: '時間',
      location: '場所',
      participants: '参加対象',
      notes: '備考',
      keyPoints: '重要ポイント',
      detail: '重要内容の要約',
      actions: 'アクション項目 / 時間',
      selectDate: '日付を選択',
      selectTime: '時間を選択',
      allDay: '終日',
      savingActionTime: '保存中',
      calendarAdded: 'カレンダー登録済み',
      actionTimeFailed: 'アクション項目の時間を保存できませんでした。',
    },
    composeView: {
      title: 'メール作成',
      cancel: 'キャンセル',
      saving: '保存中',
      draft: '下書き保存',
      sending: '送信中',
      send: '送信',
      fromAccount: '送信アカウント',
      noAccount: '接続済みのメールアカウントがありません',
      to: '宛先',
      cc: 'Cc',
      bcc: 'Bcc',
      subject: '件名',
      subjectPlaceholder: '件名を入力してください',
      body: '本文',
      attachment: '添付',
      attachFile: 'ファイル添付',
      dropHint: 'ファイルをこの領域にドラッグして添付できます。',
      needAccount: '送信するメールアカウントを選択してください。',
      needTo: '宛先を入力してください。',
      needContent: '件名または本文を入力してください。',
      sent: 'メールを送信しました。',
      sendFailed: 'メールを送信できませんでした。',
      needDraftAccount: '下書き保存するアカウントを選択してください。',
      needDraftContent: '下書き保存する内容を入力してください。',
      draftSaved: '下書きに保存しました。',
      draftFailed: '下書きを保存できませんでした。',
    },
    addressMenu: {
      compose: 'メール作成',
      copy: 'アドレスをコピー',
      addContact: '連絡先に追加',
      addVip: 'VIPリストに追加',
      search: 'このアドレスを検索',
    },
    folderMenu: {
      add: 'フォルダ追加',
      addSub: 'サブフォルダ追加',
      rename: '名前変更',
      delete: 'フォルダ削除',
      emptyTrash: 'ゴミ箱を空にする',
      color: 'フォルダ色設定',
      copyName: 'フォルダ名をコピー',
      disabledUnified: '統合フォルダは実際のアカウントフォルダではないため、この操作を直接適用できません。',
      smartDelete: 'スマートフォルダ削除',
      smartColor: '色設定',
      newFolderTitle: '新規フォルダ',
      newFolderMessage: '新しいフォルダ名を入力してください。',
      newSubFolderTitle: 'サブフォルダ',
      newSubFolderMessage: 'サブフォルダ名を入力してください。',
      renameFolderTitle: 'フォルダ名の変更',
      renameFolderMessage: '新しいフォルダ名を入力してください。',
      newSmartFolderTitle: '新規スマートフォルダ',
      newSmartFolderMessage: '新しいスマートフォルダ名を入力してください。',
      renameSmartFolderTitle: 'スマートフォルダ名の変更',
      renameSmartFolderMessage: '新しいスマートフォルダ名を入力してください。',
    },
    dialogs: {
      emptyTrashTitle: 'ゴミ箱を空にする',
      emptyUnifiedTrashTitle: 'ゴミ箱を空にする（全アカウント）',
      emptyTrashMessage: 'ゴミ箱内のすべてのメールを完全に削除します。\n\nこの操作は元に戻せません。\n\n続行しますか？',
      emptyUnifiedTrashMessage: n => `すべてのアカウントのゴミ箱内メールを完全に削除します。${n ? `\n\n対象アカウント: ${n}件` : ''}\n\nこの操作は元に戻せません。\n\n続行しますか？`,
    },
    colors: {
      default: 'デフォルト',
      red: '赤',
      orange: 'オレンジ',
      yellow: '黄',
      green: '緑',
      blue: '青',
      purple: '紫',
    },
  },
}

function getMailText(language) {
  return MAIL_TEXT[String(language || '').toLowerCase()] || MAIL_TEXT.ko
}

const UNIFIED_SYSTEM_FOLDERS = [
  { key: 'all', labelKey: 'all', icon: 'all' },
  { key: 'inbox', labelKey: 'inbox', icon: 'inbox', type: 'inbox' },
  { key: 'starred', labelKey: 'starred', icon: 'star' },
  { key: 'drafts', labelKey: 'drafts', icon: 'draft', type: 'drafts' },
  { key: 'search', labelKey: 'search', icon: 'search' },
  { key: 'sent', labelKey: 'sent', icon: 'sent', type: 'sent' },
  { key: 'trash', labelKey: 'trash', icon: 'trash', type: 'trash' },
]

function EmptyMailList({ label, mt = MAIL_TEXT.ko }) {
  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center px-6 text-center">
      <MailIcon className="w-9 h-9 text-indigo-500" />
      <h2 className="mt-4 text-base font-extrabold text-gray-900">{mt.emptyListTitle}</h2>
      <p className="mt-2 max-w-sm text-sm leading-6 text-gray-500">
        {mt.emptyListDesc(label)}
      </p>
    </div>
  )
}

function isNaverEmail(email) {
  return /@naver\.com$/i.test(String(email || '').trim())
}

// 네이버 메일 뱃지 (브랜드 그린 + 흰색 N). 별도 에셋 없이 인라인 SVG로 렌더한다.
function NaverBadge() {
  return (
    <span title="네이버 메일" aria-label="naver" className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
      <svg viewBox="0 0 40 40" className="h-4 w-4" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect width="40" height="40" rx="8" fill="#03C75A" />
        <path fill="#ffffff" d="M25.6 21.2L15.9 7H8V33H16.4V18.8L26.1 33H34V7H25.6Z" />
      </svg>
    </span>
  )
}

function isAppleEmail(email) {
  return /@(me|icloud)\.com$/i.test(String(email || '').trim())
}

// Apple 메일(iCloud/me.com) 뱃지 (검정 라운드 사각형 + 흰색 애플 로고).
function AppleBadge() {
  return (
    <span title="Apple 메일 (iCloud)" aria-label="apple" className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
      <svg viewBox="0 0 40 40" className="h-4 w-4" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect width="40" height="40" rx="8" fill="#000000" />
        <g transform="translate(8 8)">
          <path fill="#ffffff" d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.1l.01-.02zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
        </g>
      </svg>
    </span>
  )
}

function getEmailDomain(email) {
  const parts = String(email || '').trim().toLowerCase().split('@')
  return parts.length === 2 && parts[1] ? parts[1] : ''
}

function formatFileSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// 발신 도메인 파비콘. 백엔드가 DB 캐시 확인 → 없으면 웹에서 받아 저장 후 이미지를 반환한다.
// 파비콘이 없거나(404) 로드 실패 시 아무것도 표시하지 않는다.
function SenderFavicon({ domain }) {
  const [failed, setFailed] = useState(false)
  if (!domain || failed) return null
  return (
    <img
      src={`/api/mail/favicon?domain=${encodeURIComponent(domain)}`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      title={domain}
      className="h-4 w-4 flex-shrink-0 rounded-sm object-contain"
    />
  )
}

// 목록 항목 우하단 첨부 표시(클립 마크). 표시 전용. (MailService.md 10.8.8)
function AttachmentClipMark({ mt = MAIL_TEXT.ko }) {
  return (
    <svg
      viewBox="0 0 24 24" className="h-3.5 w-3.5 flex-shrink-0 text-gray-400"
      fill="none" stroke="currentColor" strokeWidth="2"
      role="img" aria-label={mt.attachmentMark} title={mt.attachmentMark}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M21.44 11.05l-9.19 9.19a5 5 0 01-7.07-7.07l9.19-9.19a3 3 0 014.24 4.24l-9.2 9.19a1 1 0 01-1.41-1.41l8.49-8.49" />
    </svg>
  )
}

function colorWithAlpha(color, alpha = 0.14) {
  const text = String(color || '').trim()
  const match = text.match(/^#?([0-9a-f]{6})$/i)
  if (!match) return `rgba(156, 163, 175, ${alpha})`
  const hex = match[1]
  const red = parseInt(hex.slice(0, 2), 16)
  const green = parseInt(hex.slice(2, 4), 16)
  const blue = parseInt(hex.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

// 리스트 카드에 붙는 스마트 폴더 태그 칩 — 색 점 + 폴더명(MailService.md 18.2).
// 색은 사이드바와 동일한 FOLDER_COLOR_MAP을 재사용해 사이드바 ↔ 카드를 시각적으로 연결한다.
function SmartFolderTagChip({ name, colorKey }) {
  // 색 미지정이어도 이름 해시로 자동 색을 부여해 "전부 회색" 문제를 없앤다(MailService.md 18.10).
  const color = resolveTagColor(colorKey, name) || '#9ca3af'
  return (
    <span
      title={name}
      className="inline-flex max-w-[130px] flex-shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none"
      // 가시성 강화(18.10.2 ②): 폴더색 테두리 + 조금 진한 틴트 + 고대비 어두운 텍스트(hue 무관하게 항상 또렷).
      style={{
        backgroundColor: colorWithAlpha(color, 0.14),
        border: `1.5px solid ${colorWithAlpha(color, 0.45)}`,
        color: '#374151',
      }}
    >
      <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
      <span className="truncate">{name}</span>
    </span>
  )
}

// activeSmartFolderId: 현재 뷰가 특정 스마트 폴더면 그 id(자기 칩은 카드에서 숨김), 아니면 null.
function MailMessageList({ messages, loading, error, label, selectedId, selectedIds, onSelect, onDoubleClick, onContextMenu, loadingMore, activeSmartFolderId, mt = MAIL_TEXT.ko }) {
  if (loading) {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-sm font-bold text-gray-500">
        {mt.loadingMessages}
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-center text-sm font-bold text-red-600">
        {error}
      </div>
    )
  }
  if (!messages.length) return <EmptyMailList label={label} mt={mt} />
  return (
    <div className="divide-y divide-gray-100">
      {messages.map((message, index) => {
        const unread = !message.is_read
        const checked = selectedIds?.has?.(message.id)
        // 스마트 폴더 태그 칩(18.2): 현재 보는 스마트 폴더 뷰면 자기 칩은 숨기고, 최대 2개 + '+N'으로 축약.
        const tags = Array.isArray(message.tags) ? message.tags : []
        const visibleTags = activeSmartFolderId ? tags.filter(tag => tag.id !== activeSmartFolderId) : tags
        const shownTags = visibleTags.slice(0, 2)
        const hiddenTags = visibleTags.slice(2)
        const hiddenTagColor = hiddenTags.length > 0
          ? resolveTagColor(hiddenTags[0].color_key, hiddenTags[0].name) || '#9ca3af'
          : '#9ca3af'
        return (
          <button
            key={message.id}
            type="button"
            draggable
            onDragStart={(event) => {
              // Shift+클릭 다중 선택이 남긴 네이티브 텍스트 선택이 남아 있으면 요소 드래그를
              // 텍스트 드래그가 가로채 커스텀 페이로드가 전달되지 않는다. 방어적으로 먼저 지운다. — MailService.md 11.9
              if (typeof window !== 'undefined') window.getSelection()?.removeAllRanges()
              // 드래그한 카드가 선택에 포함되어 있으면 선택 전체, 아니면 그 카드 하나만 이동한다.
              // (컨텍스트 메뉴 openMessageMenu 규칙과 동일) — MailService.md 11.3
              const ids = checked && selectedIds?.size > 0 ? Array.from(selectedIds) : [message.id]
              // 폴더=이동(move), 스마트 폴더=태그(copy) 두 드롭을 모두 허용해야 한다.
              // effectAllowed와 드롭 쪽 dropEffect가 불일치하면 브라우저가 드롭을 막아 onDrop이 안 뜬다. — MailService.md 13.4
              event.dataTransfer.effectAllowed = 'copyMove'
              // 파일 드롭(10.2)과 구분되도록 커스텀 MIME 타입을 쓴다.
              event.dataTransfer.setData('application/x-mail-ids', JSON.stringify(ids))
            }}
            onClick={(event) => {
              event.stopPropagation()
              onSelect?.(message, index, event)
            }}
            onDoubleClick={(event) => {
              event.stopPropagation()
              onDoubleClick?.(message, index, event)
            }}
            onContextMenu={(event) => onContextMenu?.(event, message, index)}
            className={`flex w-full select-none items-start gap-3 px-4 py-3 text-left transition ${
              checked
                ? 'bg-indigo-100 ring-1 ring-inset ring-indigo-200'
                : selectedId === message.id
                  ? 'bg-indigo-50 ring-1 ring-inset ring-indigo-100'
                  : 'hover:bg-indigo-50'
            }`}
          >
            <span className="mt-4 flex flex-shrink-0 flex-col items-center gap-2">
              {/* 중요 메일 별 마크 — 좌측 아이콘 열 맨 위 (MailService.md 14.4) */}
              {message.is_starred ? (
                <svg className="h-7 w-7 text-amber-400" viewBox="0 0 24 24" fill="currentColor" aria-label={mt.context.star}>
                  <path d="M11.48 3.5l2.12 4.3 4.74.69-3.43 3.34.81 4.72-4.24-2.23-4.24 2.23.81-4.72-3.43-3.34 4.74-.69 2.12-4.3z" />
                </svg>
              ) : null}
              <span className="flex h-3 w-3 items-center justify-center">
                {checked ? (
                  <span className="flex h-3 w-3 items-center justify-center rounded-full bg-indigo-600 text-[8px] font-black text-white">✓</span>
                ) : unread ? (
                  <span className="h-2.5 w-2.5 rounded-full bg-blue-500" />
                ) : null}
              </span>
              {isNaverEmail(message.from_email) ? (
                <NaverBadge />
              ) : isAppleEmail(message.from_email) ? (
                <AppleBadge />
              ) : (
                <SenderFavicon domain={getEmailDomain(message.from_email)} />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <span className={`truncate text-sm ${unread ? 'font-extrabold text-gray-900' : 'font-medium text-gray-500'}`}>
                  {message.from_name || message.from_email || mt.noSender}
                </span>
                <span className={`flex-shrink-0 text-[11px] ${unread ? 'font-bold text-gray-500' : 'font-normal text-gray-400'}`}>
                  {message.received_at ? new Date(message.received_at).toLocaleDateString() : ''}
                </span>
              </div>
              <div className={`mt-1 truncate text-sm ${unread ? 'font-bold text-gray-900' : 'font-normal text-gray-500'}`}>
                {message.subject || mt.noSubject}
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  {shownTags.map(tag => (
                    <SmartFolderTagChip key={tag.id} name={tag.name} colorKey={tag.color_key} />
                  ))}
                  {hiddenTags.length > 0 && (
                    <span
                      title={hiddenTags.map(tag => tag.name).join(', ')}
                      className="flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none text-gray-500"
                      style={{
                        backgroundColor: colorWithAlpha(hiddenTagColor, 0.14),
                        border: `1.5px solid ${colorWithAlpha(hiddenTagColor, 0.45)}`,
                      }}
                    >
                      +{hiddenTags.length}
                    </span>
                  )}
                  {message.snippet ? (
                    <span className={`min-w-0 truncate text-xs leading-5 ${unread ? 'text-gray-500' : 'text-gray-400'}`}>
                      {message.snippet}
                    </span>
                  ) : null}
                </div>
                {message.has_attachments && <AttachmentClipMark mt={mt} />}
              </div>
            </span>
          </button>
        )
      })}
      {loadingMore && (
        <div className="px-4 py-3 text-center text-xs font-bold text-gray-400">{mt.loadingMore}</div>
      )}
    </div>
  )
}

// 컨텍스트 메뉴 위치 자동 보정 훅. (MailService.md 19.55)
// 커서 원좌표를 받아 렌더 후 실제 크기를 실측하고, 화면 하단/우측을 벗어나면 위/왼쪽으로 접어
// 메뉴가 잘리지 않게 한다. 측정 전에는 visibility:hidden으로 깜빡임을 막는다.
function useAnchoredMenuPosition(x, y, { margin = 8 } = {}) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    // 가로: 오른쪽으로 넘치면 왼쪽으로 당기고, 그래도 음수면 여백으로.
    let left = Math.min(x, vw - rect.width - margin)
    if (left < margin) left = margin
    // 세로: 아래 공간이 충분하면 커서 아래, 부족하면 위로 펼친다. 뷰포트보다 크면 상단 정렬.
    let top = (y + rect.height + margin <= vh) ? y : Math.max(margin, y - rect.height)
    if (top + rect.height + margin > vh) top = Math.max(margin, vh - rect.height - margin)
    setPos({ left, top })
  }, [x, y, margin])
  const style = {
    left: pos ? pos.left : x,
    top: pos ? pos.top : y,
    maxHeight: `calc(100vh - ${margin * 2}px)`,
    overflowY: 'auto',
    visibility: pos ? 'visible' : 'hidden',
  }
  return { ref, style }
}

function useAnchoredSubmenuPosition(anchorRect, { margin = 8, gap = 4 } = {}) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !anchorRect) {
      setPos(null)
      return
    }
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const openRight = anchorRect.right + gap + rect.width + margin <= vw
    let left = openRight ? anchorRect.right + gap : anchorRect.left - rect.width - gap
    if (left < margin) left = margin
    if (left + rect.width + margin > vw) left = Math.max(margin, vw - rect.width - margin)
    let top = anchorRect.top
    if (top + rect.height + margin > vh) top = Math.max(margin, vh - rect.height - margin)
    setPos({ left, top })
  }, [anchorRect, margin, gap])
  const style = {
    left: pos ? pos.left : anchorRect?.right ?? 0,
    top: pos ? pos.top : anchorRect?.top ?? 0,
    maxHeight: `calc(100vh - ${margin * 2}px)`,
    overflowY: 'auto',
    visibility: pos ? 'visible' : 'hidden',
  }
  return { ref, style }
}

function MailMessageContextMenu({ menu, folders, onClose, onDelete, onMarkUnread, onToggleStar, onMove, onAgenticWatch, onRegisterMailClaw, onRegisterMailClawTrash, mt = MAIL_TEXT.ko }) {
  const { ref, style } = useAnchoredMenuPosition(menu?.x ?? 0, menu?.y ?? 0)
  const [moveSubmenuAnchor, setMoveSubmenuAnchor] = useState(null)
  const [moveSubmenuOpen, setMoveSubmenuOpen] = useState(false)
  const moveSubmenuCloseTimerRef = useRef(null)
  const { ref: moveSubmenuRef, style: moveSubmenuStyle } = useAnchoredSubmenuPosition(moveSubmenuAnchor)
  useEffect(() => () => {
    if (moveSubmenuCloseTimerRef.current) clearTimeout(moveSubmenuCloseTimerRef.current)
  }, [])
  if (!menu?.message) return null
  const moveFolders = folders.filter(folder => folder.id && folder.id !== menu.message.folder_id)
  const count = Number(menu.targetIds?.length || 1)
  // 라벨/동작 방향은 우클릭한 메일의 현재 상태 기준(14.3). 표시됨이면 '해제', 아니면 '표시'.
  const isStarred = !!menu.message.is_starred
  const openMoveSubmenu = (anchor) => {
    if (moveSubmenuCloseTimerRef.current) clearTimeout(moveSubmenuCloseTimerRef.current)
    setMoveSubmenuAnchor(anchor)
    setMoveSubmenuOpen(true)
  }
  const scheduleMoveSubmenuClose = () => {
    if (moveSubmenuCloseTimerRef.current) clearTimeout(moveSubmenuCloseTimerRef.current)
    moveSubmenuCloseTimerRef.current = setTimeout(() => setMoveSubmenuOpen(false), 120)
  }
  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[300px] whitespace-nowrap rounded-lg border border-gray-200 bg-white py-1 text-sm font-bold text-gray-700 shadow-xl shadow-gray-900/10"
      style={style}
      onClick={event => event.stopPropagation()}
    >
      {count > 1 && (
        <div className="border-b border-gray-100 px-3 py-2 text-xs font-extrabold text-indigo-600">
          {mt.selectedCount(count)}
        </div>
      )}
      <button
        type="button"
        onClick={() => {
          onDelete(menu)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-red-50"
      >
        <MenuIcon type="trash" />
        <span>{mt.context.delete}</span>
      </button>
      <button
        type="button"
        onClick={() => {
          onToggleStar?.(menu, !isStarred)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-amber-50"
      >
        <span className={isStarred ? 'text-amber-400' : 'text-gray-400'}>
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill={isStarred ? 'currentColor' : 'none'} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.48 3.5l2.12 4.3 4.74.69-3.43 3.34.81 4.72-4.24-2.23-4.24 2.23.81-4.72-3.43-3.34 4.74-.69 2.12-4.3z" />
          </svg>
        </span>
        <span>{isStarred ? mt.context.unstar : mt.context.star}</span>
      </button>
      <button
        type="button"
        onClick={() => {
          onMarkUnread(menu)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
      >
        <span className="h-2.5 w-2.5 rounded-full bg-blue-500" />
        <span>{mt.context.markUnread}</span>
      </button>
      <button
        type="button"
        onClick={() => {
          onAgenticWatch?.(menu)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-indigo-700 hover:bg-indigo-50"
      >
        <MenuIcon type="ai" />
        <span>{mt.context.agenticWatch}</span>
      </button>
      <button
        type="button"
        onClick={() => {
          onRegisterMailClaw?.(menu)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-indigo-700 hover:bg-indigo-50"
      >
        <MenuIcon type="ai" />
        <span>{mt.context.registerMailClaw}</span>
      </button>
      <button
        type="button"
        onClick={() => {
          onRegisterMailClawTrash?.(menu)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-indigo-700 hover:bg-indigo-50"
      >
        <MenuIcon type="ai" />
        <span>{mt.context.registerMailClawTrash}</span>
      </button>
      <div
        className="relative"
        onMouseLeave={scheduleMoveSubmenuClose}
      >
        <button
          type="button"
          onMouseEnter={(event) => {
            openMoveSubmenu(event.currentTarget.getBoundingClientRect())
          }}
          onFocus={(event) => {
            openMoveSubmenu(event.currentTarget.getBoundingClientRect())
          }}
          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
        >
          <MenuIcon type="folder" />
          <span className="flex-1">{mt.context.move}</span>
          <MenuIcon type="chevronRight" />
        </button>
        {moveSubmenuOpen && (
          <div
            ref={moveSubmenuRef}
            className="fixed z-[60] min-w-[230px] max-w-[320px] rounded-lg border border-gray-200 bg-white py-1 text-sm font-bold text-gray-700 shadow-xl shadow-gray-900/10"
            style={moveSubmenuStyle}
            onMouseEnter={() => {
              if (moveSubmenuCloseTimerRef.current) clearTimeout(moveSubmenuCloseTimerRef.current)
              setMoveSubmenuOpen(true)
            }}
            onMouseLeave={scheduleMoveSubmenuClose}
          >
            {moveFolders.length > 0 ? moveFolders.map(folder => (
              <button
                key={folder.id}
                type="button"
                onClick={() => {
                  onMove(menu, folder)
                  onClose()
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
              >
                <MenuIcon type={folder.type === 'inbox' ? 'inbox' : folder.type === 'trash' ? 'trash' : 'folder'} />
                <span className="min-w-0 flex-1 truncate">{getMailFolderLabel(folder, mt)}</span>
              </button>
            )) : (
              <div className="px-3 py-2 text-xs text-gray-400">{mt.context.noMoveFolders}</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyMailViewer({ mt = MAIL_TEXT.ko }) {
  return (
    <div className="flex h-full min-h-[360px] flex-col items-center justify-center px-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-indigo-50 text-indigo-500">
        <MailIcon className="w-8 h-8" />
      </div>
      <h2 className="mt-4 text-lg font-extrabold text-gray-900">{mt.selectMailTitle}</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-gray-500">
        {mt.selectMailDesc}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <ToolbarButton icon="reply" label={mt.reply} />
        <ToolbarButton icon="forward" label={mt.forward} />
        <ToolbarButton icon="ai" label={mt.sendToAgentic} />
      </div>
    </div>
  )
}

const MAIL_SUMMARY_NO_INFO = '확인된 내용 없음'

function normalizeMailSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const schedule = value.schedule && typeof value.schedule === 'object' && !Array.isArray(value.schedule)
    ? value.schedule
    : {}
  const stringOrNoInfo = item => {
    const text = String(item ?? '').trim()
    return text || MAIL_SUMMARY_NO_INFO
  }
  const arrayOrNoInfo = item => {
    if (!Array.isArray(item)) return [MAIL_SUMMARY_NO_INFO]
    const rows = item.map(row => String(row ?? '').trim()).filter(Boolean)
    return rows.length ? rows : [MAIL_SUMMARY_NO_INFO]
  }
  const actions = Array.isArray(value.actionItems) ? value.actionItems : []
  const actionItems = actions.map(item => {
    if (typeof item === 'string') return { task: stringOrNoInfo(item), time: MAIL_SUMMARY_NO_INFO }
    if (!item || typeof item !== 'object') return null
    return {
      task: stringOrNoInfo(item.task),
      time: stringOrNoInfo(item.time),
      timeSource: String(item.timeSource || '').trim(),
      isAllDay: item.isAllDay === true,
      calendarEventId: String(item.calendarEventId || '').trim(),
    }
  }).filter(Boolean)

  return {
    schedule: {
      date: stringOrNoInfo(schedule.date),
      time: stringOrNoInfo(schedule.time),
      location: stringOrNoInfo(schedule.location),
      participants: stringOrNoInfo(schedule.participants),
      notes: stringOrNoInfo(schedule.notes),
    },
    keyPoints: arrayOrNoInfo(value.keyPoints),
    summary: stringOrNoInfo(value.summary),
    actionItems: actionItems.length ? actionItems : [{ task: MAIL_SUMMARY_NO_INFO, time: MAIL_SUMMARY_NO_INFO }],
  }
}

function formatMailSummaryForCopy(summary, mt = MAIL_TEXT.ko) {
  if (!summary) return ''
  const s = mt.summary
  const scheduleRows = [
    [s.date, summary.schedule?.date],
    [s.time, summary.schedule?.time],
    [s.location, summary.schedule?.location],
    [s.participants, summary.schedule?.participants],
    [s.notes, summary.schedule?.notes],
  ]
  return [
    `${s.schedule}:`,
    ...scheduleRows.map(([label, value]) => `- ${label}: ${value || s.noInfo}`),
    '',
    s.keyPoints,
    ...(summary.keyPoints || [s.noInfo]).map(item => `- ${item}`),
    '',
    s.detail,
    summary.summary || s.noInfo,
    '',
    s.actions,
    ...(summary.actionItems || [{ task: s.noInfo, time: s.noInfo }])
      .map(item => `- ${item.task || s.noInfo}${item.time ? ` (${formatSummaryActionTimeLabel(item, mt)})` : ''}`),
  ].join('\n')
}

async function copyTextWithFallback(text) {
  const normalized = String(text || '').trim()
  if (!normalized) return false

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(normalized)
      return true
    }
  } catch {
    // Clipboard API may be blocked on non-secure origins or embedded browsers.
  }

  if (typeof document === 'undefined') return false

  let textarea = null
  try {
    textarea = document.createElement('textarea')
    textarea.value = normalized
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    textarea.style.top = '0'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    if (textarea?.parentNode) textarea.parentNode.removeChild(textarea)
  }
}

function MailSummaryValue({ label, value, noInfo = MAIL_SUMMARY_NO_INFO }) {
  const empty = !value || value === MAIL_SUMMARY_NO_INFO || value === noInfo
  return (
    <div className="rounded-md border border-indigo-100 bg-white px-3 py-2">
      <div className="text-[11px] font-extrabold text-indigo-500">{label}</div>
      <div className={`mt-1 text-sm font-bold ${empty ? 'text-gray-400' : 'text-gray-800'}`}>{value || noInfo}</div>
    </div>
  )
}

const MAIL_SUMMARY_NO_INFO_VALUES = new Set([
  MAIL_SUMMARY_NO_INFO,
  'No confirmed information',
  '確認できる内容なし',
])

function parseSummaryActionDateTime(value) {
  const text = String(value || '').trim()
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  if (match) {
    return {
      date: `${match[1]}-${match[2]}-${match[3]}`,
      time: `${match[4]}:${match[5]}`,
    }
  }
  const dateOnlyMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!dateOnlyMatch) return { date: '', time: '' }
  return {
    date: `${dateOnlyMatch[1]}-${dateOnlyMatch[2]}-${dateOnlyMatch[3]}`,
    time: '',
  }
}

function formatSummaryActionTimeLabel(item, mt = MAIL_TEXT.ko) {
  const s = mt.summary
  const parsed = parseSummaryActionDateTime(item?.time)
  if (item?.isAllDay && parsed.date) return parsed.date
  return item?.time || s.noInfo
}

function formatDraftSummaryActionTimeLabel(item, draft, mt = MAIL_TEXT.ko) {
  const s = mt.summary
  const saved = parseSummaryActionDateTime(item?.time)
  const date = draft?.date ?? saved.date
  const time = draft?.time ?? saved.time
  const isAllDay = draft?.isAllDay ?? item?.isAllDay === true
  if (isAllDay && date) return date
  if (date && time) return `${date} ${time}`
  return formatSummaryActionTimeLabel(item, mt) || s.noInfo
}

function MailSummaryPanel({
  summary,
  mt = MAIL_TEXT.ko,
  actionTimeDrafts = {},
  actionTimeSavingKey = '',
  actionTimeError = '',
  onActionTimeChange,
  onCalendarEventOpen,
}) {
  const [openActionMenu, setOpenActionMenu] = useState(null)
  if (!summary) return null
  const schedule = summary.schedule || {}
  const s = mt.summary
  return (
    <div className="rounded-lg border border-indigo-100 bg-indigo-50/60 p-4 text-sm text-gray-800">
      <section>
        <h3 className="text-sm font-extrabold text-gray-950">{s.schedule}</h3>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <MailSummaryValue label={s.date} value={schedule.date} noInfo={s.noInfo} />
          <MailSummaryValue label={s.time} value={schedule.time} noInfo={s.noInfo} />
          <MailSummaryValue label={s.location} value={schedule.location} noInfo={s.noInfo} />
          <MailSummaryValue label={s.participants} value={schedule.participants} noInfo={s.noInfo} />
          <MailSummaryValue label={s.notes} value={schedule.notes} noInfo={s.noInfo} />
        </div>
      </section>

      <section className="mt-5">
        <h3 className="text-sm font-extrabold text-gray-950">{s.keyPoints}</h3>
        <ul className="mt-2 space-y-1.5">
          {(summary.keyPoints || [s.noInfo]).map((item, index) => (
            <li key={`${item}-${index}`} className="flex gap-2 leading-6">
              <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-indigo-400" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-5">
        <h3 className="text-sm font-extrabold text-gray-950">{s.detail}</h3>
        <p className="mt-2 leading-7">{summary.summary || s.noInfo}</p>
      </section>

      <section className="mt-5">
        <h3 className="text-sm font-extrabold text-gray-950">{s.actions}</h3>
        <div className="mt-2 divide-y divide-indigo-100 rounded-md border border-indigo-100 bg-white">
          {(summary.actionItems || [{ task: s.noInfo, time: s.noInfo }]).map((item, index) => {
            const savedDateTime = parseSummaryActionDateTime(item.time)
            const draft = actionTimeDrafts[index] || {}
            const dateValue = draft.date ?? savedDateTime.date
            const timeValue = draft.time ?? savedDateTime.time
            const isAllDay = draft.isAllDay ?? item.isAllDay === true
            const menuOpen = openActionMenu === index
            return (
              <div key={`${item.task}-${index}`} className="grid gap-2 px-3 py-2 lg:grid-cols-[1fr_auto] lg:items-center">
                <span className="font-bold text-gray-800">{item.task || s.noInfo}</span>
                <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                  <div className="relative">
                    <button
                      type="button"
                      aria-expanded={menuOpen}
                      onClick={() => setOpenActionMenu(prev => (prev === index ? null : index))}
                      className="inline-flex h-8 min-w-[128px] items-center justify-between gap-2 rounded-md border border-indigo-100 bg-indigo-50/50 px-2.5 text-xs font-extrabold text-gray-600 transition hover:border-indigo-200 hover:bg-indigo-50"
                    >
                      <span>{formatDraftSummaryActionTimeLabel(item, draft, mt)}</span>
                      <span className={`transition-transform ${menuOpen ? 'rotate-180' : ''}`}>
                        <MenuIcon type="chevronDown" />
                      </span>
                    </button>
                    {menuOpen && (
                      <div className="absolute right-0 z-30 mt-2 w-[278px] rounded-lg border border-indigo-100 bg-white p-3 shadow-xl shadow-indigo-100/70">
                        <label className="block text-[11px] font-extrabold text-gray-500">
                          {s.selectDate}
                          <input
                            type="date"
                            value={dateValue}
                            aria-label={s.selectDate}
                            title={s.selectDate}
                            onChange={event => onActionTimeChange?.(index, { date: event.target.value })}
                            className="mt-1 h-9 w-full rounded-md border border-indigo-100 bg-indigo-50/50 px-2 text-xs font-bold text-gray-700 outline-none transition focus:border-indigo-300 focus:bg-white"
                          />
                        </label>
                        <div className="mt-3 flex items-center justify-between rounded-md border border-indigo-100 bg-indigo-50/40 px-2.5 py-2 text-xs font-extrabold text-gray-600">
                          <span className={isAllDay ? 'text-indigo-700' : 'text-gray-500'}>{s.allDay}</span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={isAllDay}
                            aria-label={s.allDay}
                            title={s.allDay}
                            onClick={() => onActionTimeChange?.(index, { isAllDay: !isAllDay })}
                            className={`relative h-5 w-10 flex-shrink-0 rounded-full transition ${
                              isAllDay ? 'bg-indigo-600' : 'bg-gray-300'
                            }`}
                          >
                            <span className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${isAllDay ? 'translate-x-5' : 'translate-x-0.5'}`} />
                          </button>
                        </div>
                        <label className="mt-3 block text-[11px] font-extrabold text-gray-500">
                          {s.selectTime}
                          <input
                            type="time"
                            value={timeValue}
                            aria-label={s.selectTime}
                            title={s.selectTime}
                            disabled={isAllDay}
                            onChange={event => onActionTimeChange?.(index, { time: event.target.value })}
                            className="mt-1 h-9 w-full rounded-md border border-indigo-100 bg-indigo-50/50 px-2 text-xs font-bold text-gray-700 outline-none transition focus:border-indigo-300 focus:bg-white disabled:cursor-not-allowed disabled:border-gray-100 disabled:bg-gray-50 disabled:text-gray-400"
                          />
                        </label>
                      </div>
                    )}
                  </div>
                  {actionTimeSavingKey === String(index) && (
                    <span className="text-[11px] font-extrabold text-indigo-500">{s.savingActionTime}</span>
                  )}
                  {item.calendarEventId && (
                    <button
                      type="button"
                      onClick={() => onCalendarEventOpen?.(item.calendarEventId)}
                      className="rounded px-1.5 py-1 text-[11px] font-extrabold text-indigo-500 underline decoration-indigo-200 underline-offset-2 transition hover:bg-indigo-50 hover:text-indigo-700"
                    >
                      {s.calendarAdded}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        {actionTimeError && (
          <p className="mt-2 text-xs font-bold text-red-500">{actionTimeError}</p>
        )}
      </section>
    </div>
  )
}

function ComposeToolbarButton({ active = false, onClick, children, title, disabled = false }) {
  return (
    <button
      type="button"
      onMouseDown={event => {
        event.preventDefault()
        onClick?.()
      }}
      title={title}
      disabled={disabled}
      className={`flex h-10 min-w-10 items-center justify-center rounded-md px-2 text-sm font-extrabold transition ${
        active
          ? 'bg-gray-100 text-gray-950'
          : 'text-gray-700 hover:bg-gray-100 hover:text-gray-950'
      } disabled:cursor-not-allowed disabled:opacity-35`}
    >
      {children}
    </button>
  )
}

function ComposeToolbarSelect({ value, onChange, options, title, className = '' }) {
  return (
    <label className={`relative flex h-10 items-center ${className}`} title={title}>
      <select
        value={value}
        onChange={event => onChange(event.target.value)}
        className="h-10 cursor-pointer appearance-none rounded-md border-0 bg-transparent py-0 pl-2 pr-8 text-sm font-semibold text-gray-600 outline-none transition hover:bg-gray-100 focus:bg-gray-100"
      >
        {options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-800">
        <MenuIcon type="chevronDown" />
      </span>
    </label>
  )
}

function ComposeToolbarDivider() {
  return <span className="mx-1 h-10 w-px flex-shrink-0 bg-gray-200" />
}

function ComposeHistoryIcon({ direction = 'undo', className = 'h-6 w-6' }) {
  const mirrored = direction === 'redo'
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.15"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={mirrored ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path d="M9 5 5 9l4 4" />
      <path d="M5 9h7a7 7 0 1 1-6.02 3.44" />
    </svg>
  )
}

function ComposeColorButton({ title, value, onChange, children }) {
  return (
    <label
      className="relative flex h-10 min-w-10 cursor-pointer items-center justify-center rounded-md px-2 text-sm font-extrabold text-gray-700 transition hover:bg-gray-100 hover:text-gray-950"
      title={title}
    >
      {children}
      <input
        type="color"
        value={value}
        onChange={event => onChange(event.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        aria-label={title}
      />
    </label>
  )
}

function MailComposeToolbar() {
  const [editor] = useLexicalComposerContext()
  const [blockStyle, setBlockStyle] = useState('normal')
  const [fontFamily, setFontFamily] = useState('Arial')
  const [fontSize, setFontSize] = useState(16)
  const [textColor, setTextColor] = useState('#111827')
  const [highlightColor, setHighlightColor] = useState('#ffffff')
  const [align, setAlign] = useState('left')

  function applyTextStyle(style) {
    editor.update(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) $patchStyleText(selection, style)
    })
  }

  function changeBlockStyle(value) {
    setBlockStyle(value)
    const sizeByBlock = {
      normal: '14px',
      title: '22px',
      subtitle: '18px',
    }
    const weightByBlock = {
      normal: '400',
      title: '700',
      subtitle: '700',
    }
    applyTextStyle({
      'font-size': sizeByBlock[value] || '14px',
      'font-weight': weightByBlock[value] || '400',
    })
  }

  function changeFontFamily(value) {
    setFontFamily(value)
    applyTextStyle({ 'font-family': value })
  }

  function changeFontSize(value) {
    const nextSize = Math.max(8, Math.min(72, Number(value) || 16))
    setFontSize(nextSize)
    applyTextStyle({ 'font-size': `${nextSize}px` })
  }

  function changeTextColor(value) {
    setTextColor(value)
    applyTextStyle({ color: value })
  }

  function changeHighlightColor(value) {
    setHighlightColor(value)
    applyTextStyle({ 'background-color': value })
  }

  function changeAlign(value) {
    setAlign(value)
    editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, value)
  }

  function editLink() {
    const url = window.prompt('링크 URL을 입력하세요')
    if (!url) return
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, url)
  }

  function handleInsert(value) {
    if (value === 'bullet') editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)
    if (value === 'number') editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)
    if (value === 'link') editLink()
  }

  return (
    <div className="flex min-h-[56px] flex-wrap items-center gap-1 border-b border-gray-200 bg-white px-4 py-2 shadow-sm">
      <ComposeToolbarButton title="실행 취소" onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}>
        <ComposeHistoryIcon direction="undo" className="h-6 w-6 text-gray-600" />
      </ComposeToolbarButton>
      <ComposeToolbarButton title="다시 실행" onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}>
        <ComposeHistoryIcon direction="redo" className="h-6 w-6 text-gray-300" />
      </ComposeToolbarButton>
      <ComposeToolbarDivider />
      <ComposeToolbarSelect
        value={blockStyle}
        onChange={changeBlockStyle}
        title="문단 스타일"
        className="w-[170px]"
        options={[
          { value: 'normal', label: 'Normal' },
          { value: 'title', label: 'Title' },
          { value: 'subtitle', label: 'Subtitle' },
        ]}
      />
      <ComposeToolbarDivider />
      <ComposeToolbarSelect
        value={fontFamily}
        onChange={changeFontFamily}
        title="글꼴"
        className="w-[150px]"
        options={[
          { value: 'Arial', label: 'Arial' },
          { value: 'Helvetica', label: 'Helvetica' },
          { value: 'Georgia', label: 'Georgia' },
          { value: 'Times New Roman', label: 'Times' },
          { value: 'Courier New', label: 'Courier' },
        ]}
      />
      <ComposeToolbarDivider />
      <ComposeToolbarButton title="글자 크기 줄이기" onClick={() => changeFontSize(fontSize - 1)}>−</ComposeToolbarButton>
      <input
        type="number"
        min="8"
        max="72"
        value={fontSize}
        onChange={event => changeFontSize(event.target.value)}
        className="h-9 w-14 rounded-lg border-2 border-gray-400 bg-white text-center text-sm font-extrabold text-gray-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
        title="글자 크기"
      />
      <ComposeToolbarButton title="글자 크기 키우기" onClick={() => changeFontSize(fontSize + 1)}>+</ComposeToolbarButton>
      <ComposeToolbarDivider />
      <ComposeToolbarButton title="굵게" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')}>B</ComposeToolbarButton>
      <ComposeToolbarButton title="기울임" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')}>
        <span className="italic">I</span>
      </ComposeToolbarButton>
      <ComposeToolbarButton title="밑줄" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'underline')}>
        <span className="underline">U</span>
      </ComposeToolbarButton>
      <ComposeToolbarButton title="인라인 코드" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'code')}>&lt;&gt;</ComposeToolbarButton>
      <ComposeToolbarButton title="링크" onClick={editLink}>⌁</ComposeToolbarButton>
      <ComposeColorButton title="글자 색상" value={textColor} onChange={changeTextColor}>
        <span className="border-b-2" style={{ borderColor: textColor }}>A</span>
      </ComposeColorButton>
      <ComposeColorButton title="배경 색상" value={highlightColor} onChange={changeHighlightColor}>
        <span className="rounded-sm px-1" style={{ backgroundColor: highlightColor }}>◆</span>
      </ComposeColorButton>
      <ComposeToolbarSelect
        value="none"
        onChange={value => applyTextStyle({ 'text-transform': value })}
        title="대소문자"
        className="w-[86px]"
        options={[
          { value: 'none', label: 'Aa' },
          { value: 'uppercase', label: 'AA' },
          { value: 'lowercase', label: 'aa' },
        ]}
      />
      <ComposeToolbarDivider />
      <ComposeToolbarSelect
        value=""
        onChange={handleInsert}
        title="삽입"
        className="w-[136px]"
        options={[
          { value: '', label: '+ Insert' },
          { value: 'bullet', label: 'Bullet List' },
          { value: 'number', label: 'Number List' },
          { value: 'link', label: 'Link' },
        ]}
      />
      <ComposeToolbarDivider />
      <ComposeToolbarSelect
        value={align}
        onChange={changeAlign}
        title="정렬"
        className="w-[165px]"
        options={[
          { value: 'left', label: 'Left Align' },
          { value: 'center', label: 'Center Align' },
          { value: 'right', label: 'Right Align' },
          { value: 'justify', label: 'Justify' },
        ]}
      />
    </div>
  )
}

function InitialHtmlPlugin({ html, focusEmptyTop = false }) {
  const [editor] = useLexicalComposerContext()
  const appliedRef = useRef(false)

  useEffect(() => {
    if (appliedRef.current || !html) return
    appliedRef.current = true
    editor.update(() => {
      const parser = new DOMParser()
      const dom = parser.parseFromString(html, 'text/html')
      const nodes = $generateNodesFromDOM(editor, dom)
      const root = $getRoot()
      root.clear()
      if (focusEmptyTop) {
        const blankParagraph = $createParagraphNode()
        root.append(blankParagraph)
        if (nodes.length) root.append(...nodes)
        blankParagraph.select()
      } else if (nodes.length) {
        root.append(...nodes)
      }
    })
  }, [editor, focusEmptyTop, html])

  return null
}

function MailComposeEditor({ onChange, initialHtml = '', focusEmptyTop = false }) {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'EasyStationMailCompose',
        nodes: [ListNode, ListItemNode, LinkNode],
        theme: {
          paragraph: 'mb-3',
          list: {
            ul: 'list-disc pl-6 mb-3',
            ol: 'list-decimal pl-6 mb-3',
            listitem: 'mb-1',
          },
          text: {
            bold: 'font-bold',
            italic: 'italic',
            underline: 'underline',
          },
        },
        onError(error) {
          console.error('[MailCompose Lexical]', error)
        },
      }}
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white">
        <MailComposeToolbar />
        <div className="relative min-h-[180px] flex-1 overflow-y-auto">
          <RichTextPlugin
            contentEditable={
              <ContentEditable className="min-h-full px-4 py-4 text-sm leading-7 text-gray-800 outline-none" />
            }
            placeholder={
              <div className="pointer-events-none absolute left-4 top-4 text-sm text-gray-400">
                메일 본문을 입력하세요.
              </div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <ListPlugin />
          <LinkPlugin />
          <InitialHtmlPlugin html={initialHtml} focusEmptyTop={focusEmptyTop} />
          <OnChangePlugin
            onChange={(editorState, editor) => {
              editorState.read(() => {
                const root = $getRoot()
                const text = root.getTextContent()
                const html = $generateHtmlFromNodes(editor, null)
                onChange?.({ html, text })
              })
            }}
          />
        </div>
      </div>
    </LexicalComposer>
  )
}

function MailComposeView({ accounts, defaultAccountId, initialDraft, onCancel, onSent, onDraftSaved, mt = MAIL_TEXT.ko }) {
  const cv = mt.composeView
  const selectableAccounts = accounts.filter(account => account?.id && account?.tenant_id)
  const [accountId, setAccountId] = useState(initialDraft?.accountId || defaultAccountId || selectableAccounts[0]?.id || '')
  const [draftId, setDraftId] = useState(initialDraft?.draftId || '')
  const [to, setTo] = useState(initialDraft?.to || '')
  const [cc, setCc] = useState(initialDraft?.cc || '')
  const [bcc, setBcc] = useState(initialDraft?.bcc || '')
  const [subject, setSubject] = useState(initialDraft?.subject || '')
  const [body, setBody] = useState({ html: initialDraft?.html || '', text: initialDraft?.text || '' })
  const [sending, setSending] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [attachments, setAttachments] = useState([])
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef(null)
  // 첨부 이미지 미리보기 URL(File → objectURL). 첨부 변경 시 재생성하고 정리(revoke)한다. (MailService.md 10.10)
  const [attachmentPreviews, setAttachmentPreviews] = useState(() => new Map())
  const [lightboxImage, setLightboxImage] = useState(null) // { url, name } 확대 보기
  useEffect(() => {
    const map = new Map()
    for (const file of attachments) {
      if (isPreviewableImageFile(file)) {
        try { map.set(file, URL.createObjectURL(file)) } catch { /* noop */ }
      }
    }
    setAttachmentPreviews(map)
    return () => { for (const url of map.values()) URL.revokeObjectURL(url) }
  }, [attachments])
  // 첨부 정책(용량/개수/차단 확장자)은 서버에서 로드한다. (MailService.md 10.8)
  const [attachPolicy, setAttachPolicy] = useState(DEFAULT_ATTACH_POLICY)

  useEffect(() => {
    let alive = true
    apiFetch('/mail/attachment-policy')
      .then(p => { if (alive && p) setAttachPolicy(normalizeAttachPolicy(p)) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!accountId && selectableAccounts[0]?.id) setAccountId(selectableAccounts[0].id)
  }, [accountId, selectableAccounts])

  useEffect(() => {
    if (!initialDraft) return
    setAccountId(initialDraft.accountId || defaultAccountId || selectableAccounts[0]?.id || '')
    setDraftId(initialDraft.draftId || '')
    setTo(initialDraft.to || '')
    setCc(initialDraft.cc || '')
    setBcc(initialDraft.bcc || '')
    setSubject(initialDraft.subject || '')
    setBody({ html: initialDraft.html || '', text: initialDraft.text || '' })
    setAttachments([])
    setStatus('')
    setError('')
  }, [defaultAccountId, initialDraft?.draftId])

  const selectedAccount = selectableAccounts.find(account => account.id === accountId)

  // 클립 버튼/Drag&Drop 공통: 파일을 첨부 목록에 추가한다.
  // 정책 강제: 차단 확장자 / 단일 상한 / 개수 상한 / 합계 상한 (MailService.md 10.8.6)
  function addFiles(fileList) {
    const incoming = Array.from(fileList || [])
    if (incoming.length === 0) return
    setError('')
    const maxFileBytes = attachPolicy.maxFileMb * 1024 * 1024
    const maxTotalBytes = attachPolicy.maxTotalMb * 1024 * 1024
    setAttachments(prev => {
      const merged = [...prev]
      for (const file of incoming) {
        if (merged.some(x => x.name === file.name && x.size === file.size)) continue
        const ext = fileExtOf(file.name)
        if (attachPolicy.blockedExtensions.includes(ext)) {
          setError(`허용되지 않는 파일 형식입니다: ${file.name}`)
          continue
        }
        if (file.size > maxFileBytes) {
          setError(`'${file.name}' 파일이 단일 첨부 상한(${attachPolicy.maxFileMb}MB)을 초과했습니다.`)
          continue
        }
        if (merged.length >= attachPolicy.maxFiles) {
          setError(`첨부파일은 최대 ${attachPolicy.maxFiles}개까지 추가할 수 있습니다.`)
          break
        }
        if (merged.reduce((sum, f) => sum + f.size, 0) + file.size > maxTotalBytes) {
          setError(`첨부파일 합계 용량이 ${attachPolicy.maxTotalMb}MB를 초과했습니다.`)
          continue
        }
        merged.push(file)
      }
      return merged
    })
  }

  function removeAttachment(index) {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }

  function handleDrop(event) {
    event.preventDefault()
    setDragOver(false)
    if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files)
  }

  async function sendMail() {
    setError('')
    setStatus('')
    if (!selectedAccount) {
      setError(cv.needAccount)
      return
    }
    if (!to.trim()) {
      setError(cv.needTo)
      return
    }
    if (!subject.trim() && !body.text.trim() && attachments.length === 0) {
      setError(cv.needContent)
      return
    }
    setSending(true)
    try {
      // 첨부 전송을 위해 multipart/form-data 로 보낸다. (apiFetch는 JSON 전용이라 fetch 사용)
      const form = new FormData()
      form.append('tenantId', selectedAccount.tenant_id)
      form.append('to', to)
      form.append('cc', cc)
      form.append('bcc', bcc)
      form.append('subject', subject)
      form.append('html', body.html)
      form.append('text', body.text)
      for (const file of attachments) form.append('attachments', file, file.name)

      const res = await fetch(`/api/mail/accounts/${selectedAccount.id}/send`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      setStatus(cv.sent)
      setAttachments([])
      onSent?.()
    } catch (err) {
      setError(err.message || cv.sendFailed)
    } finally {
      setSending(false)
    }
  }

  async function saveDraft() {
    setError('')
    setStatus('')
    if (!selectedAccount) {
      setError(cv.needDraftAccount)
      return
    }
    if (!subject.trim() && !body.text.trim() && !to.trim() && !cc.trim() && !bcc.trim()) {
      setError(cv.needDraftContent)
      return
    }
    setSavingDraft(true)
    try {
      const result = await apiFetch(`/mail/accounts/${selectedAccount.id}/drafts`, {
        method: 'POST',
        body: JSON.stringify({
          tenantId: selectedAccount.tenant_id,
          draftId,
          to,
          cc,
          bcc,
          subject,
          html: body.html,
          text: body.text,
        }),
      })
      const nextDraftId = result?.draft?.id || draftId
      setDraftId(nextDraftId)
      setStatus(cv.draftSaved)
      onDraftSaved?.(selectedAccount.id, result?.draft)
    } catch (err) {
      setError(err.message || cv.draftFailed)
    } finally {
      setSavingDraft(false)
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-white">
      <header className="flex-shrink-0 border-b border-gray-100 px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-extrabold text-gray-900">{cv.title}</h2>
          </div>
          <div className="flex items-center gap-2">
            <ToolbarButton icon="back" label={cv.cancel} onClick={onCancel} disabled={sending || savingDraft} />
            <ToolbarButton icon="draft" label={savingDraft ? cv.saving : cv.draft} onClick={saveDraft} disabled={sending || savingDraft || selectableAccounts.length === 0} />
            <ToolbarButton icon="sent" label={sending ? cv.sending : cv.send} primary onClick={sendMail} disabled={sending || savingDraft || selectableAccounts.length === 0} />
          </div>
        </div>
      </header>

      <div
        className={`min-h-0 flex-1 overflow-y-auto px-6 py-4 ${dragOver ? 'bg-indigo-50/40 ring-2 ring-inset ring-indigo-400' : ''}`}
        onDragOver={(event) => { event.preventDefault(); if (!dragOver) setDragOver(true) }}
        onDragLeave={(event) => { if (event.currentTarget === event.target) setDragOver(false) }}
        onDrop={handleDrop}
      >
        <div className="flex min-h-full flex-col gap-2.5">
          <label className="grid gap-2 text-sm font-bold text-gray-600 md:grid-cols-[96px_1fr] md:items-center">
            <span>{cv.fromAccount}</span>
            <select
              value={accountId}
              onChange={event => setAccountId(event.target.value)}
              className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            >
              {selectableAccounts.length === 0 ? (
                <option value="">{cv.noAccount}</option>
              ) : selectableAccounts.map(account => (
                <option key={account.id} value={account.id}>
                  {getAccountLabel(account)} &lt;{account.email_address}&gt;
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-2 text-sm font-bold text-gray-600 md:grid-cols-[96px_1fr] md:items-center">
            <span>{cv.to}</span>
            <input
              value={to}
              onChange={event => setTo(event.target.value)}
              placeholder="name@example.com, another@example.com"
              className="h-10 rounded-lg border border-gray-200 px-3 text-sm text-gray-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </label>

          <div className="grid gap-3 lg:grid-cols-2">
            <label className="grid gap-2 text-sm font-bold text-gray-600 md:grid-cols-[96px_1fr] md:items-center">
              <span>{cv.cc}</span>
              <input
                value={cc}
                onChange={event => setCc(event.target.value)}
                placeholder="cc@example.com"
                className="h-10 rounded-lg border border-gray-200 px-3 text-sm text-gray-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </label>
            <label className="grid gap-2 text-sm font-bold text-gray-600 md:grid-cols-[96px_1fr] md:items-center">
              <span>{cv.bcc}</span>
              <input
                value={bcc}
                onChange={event => setBcc(event.target.value)}
                placeholder="bcc@example.com"
                className="h-10 rounded-lg border border-gray-200 px-3 text-sm text-gray-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </label>
          </div>

          <label className="grid gap-2 text-sm font-bold text-gray-600 md:grid-cols-[96px_1fr] md:items-center">
            <span>{cv.subject}</span>
            <input
              value={subject}
              onChange={event => setSubject(event.target.value)}
              placeholder={cv.subjectPlaceholder}
              className="h-10 rounded-lg border border-gray-200 px-3 text-sm text-gray-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
          </label>

          <div className="grid min-h-[220px] flex-1 gap-2 text-sm font-bold text-gray-600 md:grid-cols-[96px_minmax(0,1fr)]">
            <span className="pt-3">{cv.body}</span>
            <MailComposeEditor
              onChange={setBody}
              initialHtml={initialDraft?.html || ''}
              focusEmptyTop={!!initialDraft?.focusEmptyTop}
            />
          </div>

          <div className="grid flex-shrink-0 gap-2 text-sm font-bold text-gray-600 md:grid-cols-[96px_1fr]">
            <span className="pt-2">{cv.attachment}</span>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => { addFiles(event.target.files); event.target.value = '' }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-bold text-gray-600 hover:border-indigo-300 hover:bg-indigo-50"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21.44 11.05l-9.19 9.19a5 5 0 01-7.07-7.07l9.19-9.19a3 3 0 014.24 4.24l-9.2 9.19a1 1 0 01-1.41-1.41l8.49-8.49" />
                  </svg>
                  {cv.attachFile}
                </button>
                <span className="text-[11px] font-normal text-gray-400">{cv.dropHint}</span>
              </div>
              {attachments.length > 0 && (
                <div className="mt-2">
                  <div className="mb-1 text-[11px] font-bold text-gray-500">{mt.attachmentCount(attachments.length)}</div>
                  <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto pr-1">
                    {attachments.map((file, index) => {
                      const previewUrl = attachmentPreviews.get(file)
                      return (
                      <span
                        key={`${file.name}-${file.size}-${index}`}
                        className="flex max-w-[240px] items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5"
                        title={`${file.name} (${formatFileSize(file.size)})`}
                      >
                        {previewUrl ? (
                          <button
                            type="button"
                            onClick={() => setLightboxImage({ url: previewUrl, name: file.name })}
                            title="클릭하면 크게 봅니다"
                            className="flex-shrink-0 overflow-hidden rounded-md border border-gray-200 bg-white transition hover:ring-2 hover:ring-indigo-300"
                          >
                            <img src={previewUrl} alt={file.name} className="h-10 w-10 object-cover" />
                          </button>
                        ) : null}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-bold text-gray-800">{file.name}</span>
                          <span className="block text-[11px] font-normal text-gray-400">{formatFileSize(file.size)}</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => removeAttachment(index)}
                          aria-label="첨부 삭제"
                          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-500"
                        >
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </span>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          {(error || status) && (
            <p className={`flex-shrink-0 rounded-lg px-3 py-2 text-sm font-bold ${
              error ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'
            }`}>
              {error || status}
            </p>
          )}
        </div>
      </div>
      {lightboxImage && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6"
          onClick={() => setLightboxImage(null)}
          role="dialog"
          aria-modal="true"
        >
          <img
            src={lightboxImage.url}
            alt={lightboxImage.name}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
            onClick={event => event.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setLightboxImage(null)}
            aria-label="닫기"
            className="absolute right-6 top-6 flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-gray-700 shadow-lg hover:bg-white"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </section>
  )
}

function normalizeAddressList(value) {
  if (!Array.isArray(value)) return []
  return value
    .map(item => ({
      name: String(item?.name || '').trim(),
      email: String(item?.email || item?.address || '').trim(),
    }))
    .filter(item => item.name || item.email)
}

function formatAddress(address) {
  if (!address?.email) return address?.name || ''
  return address.name ? `${address.name} <${address.email}>` : address.email
}

function addressListToInput(value) {
  return normalizeAddressList(value).map(formatAddress).join(', ')
}

function addressListToSearchText(value) {
  return normalizeAddressList(value)
    .map(item => `${item.name} ${item.email}`.trim())
    .join(' ')
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function textToDraftHtml(value) {
  const lines = String(value || '').split(/\r?\n/)
  if (!lines.length) return ''
  return lines.map(line => `<p>${escapeHtml(line) || '<br>'}</p>`).join('')
}

function getDraftComposeData(message, accountId) {
  const text = message?.body_text || message?.snippet || ''
  return {
    draftId: message?.id || '',
    accountId: message?.account_id || accountId || '',
    to: addressListToInput(message?.to_json),
    cc: addressListToInput(message?.cc_json),
    bcc: addressListToInput(message?.bcc_json),
    subject: message?.subject || '',
    html: message?.body_html || textToDraftHtml(text),
    text,
  }
}

function addSubjectPrefix(subject, prefix) {
  const value = String(subject || '').trim() || '(제목 없음)'
  const pattern = new RegExp(`^${prefix.replace(':', '')}\\s*:`, 'i')
  return pattern.test(value) ? value : `${prefix} ${value}`
}

function normalizeMailThreadSubject(subject) {
  let value = String(subject || '').trim()
  let previous
  do {
    previous = value
    value = value.replace(/^\s*(re|fw|fwd)\s*:\s*/i, '')
  } while (value !== previous)
  return value.replace(/\s+/g, ' ').trim()
}

function uniqueAddresses(addresses, excludedEmails = new Set()) {
  const seen = new Set()
  return normalizeAddressList(addresses).filter(address => {
    const email = String(address.email || '').trim().toLowerCase()
    const key = email || String(address.name || '').trim().toLowerCase()
    if (!key || excludedEmails.has(email) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function formatOriginalDate(message) {
  const value = message?.received_at || message?.sent_at || message?.created_at || ''
  if (!value) return '-'
  try {
    return new Date(value).toLocaleString()
  } catch (_) {
    return String(value)
  }
}

function buildOriginalMessageHtml(message, mode) {
  const from = formatAddress({ name: message?.from_name || '', email: message?.from_email || '' }) || '-'
  const to = addressListToInput(message?.to_json) || '-'
  const cc = addressListToInput(message?.cc_json)
  const subject = message?.subject || '(제목 없음)'
  const body = message?.body_html || textToDraftHtml(message?.body_text || message?.snippet || '')
  const title = mode === 'forward' ? '-----Forwarded Message-----' : '-----Original Message-----'
  const ccLine = cc ? `<br><b>Cc:</b> ${escapeHtml(cc)}` : ''

  return [
    '<p><br></p>',
    `<p>${escapeHtml(title)}<br>`,
    `<b>From:</b> ${escapeHtml(from)}<br>`,
    `<b>To:</b> ${escapeHtml(to)}${ccLine}<br>`,
    `<b>Date:</b> ${escapeHtml(formatOriginalDate(message))}<br>`,
    `<b>Subject:</b> ${escapeHtml(subject)}</p>`,
    '<div>',
    body,
    '</div>',
  ].join('')
}

function getMailActionComposeData(message, action, accountId, ownEmails = new Set()) {
  const from = uniqueAddresses([{ name: message?.from_name || '', email: message?.from_email || '' }])
  const originalTo = normalizeAddressList(message?.to_json)
  const originalCc = normalizeAddressList(message?.cc_json)
  const isForward = action === 'forward'
  const isReplyAll = action === 'replyAll'

  return {
    accountId: message?.account_id || accountId || '',
    draftId: '',
    to: isForward
      ? ''
      : addressListToInput(isReplyAll ? uniqueAddresses([...from, ...originalTo]) : from),
    cc: isReplyAll ? addressListToInput(uniqueAddresses(originalCc)) : '',
    bcc: '',
    subject: addSubjectPrefix(message?.subject, isForward ? 'FWD:' : 'RE:'),
    html: buildOriginalMessageHtml(message, isForward ? 'forward' : 'reply'),
    text: '',
    focusEmptyTop: true,
  }
}

function saveAddressListItem(key, address) {
  if (!address?.email) return
  try {
    const rows = JSON.parse(window.localStorage.getItem(key) || '[]')
    const next = Array.isArray(rows) ? rows.filter(item => item?.email !== address.email) : []
    next.unshift({ name: address.name || '', email: address.email, savedAt: new Date().toISOString() })
    window.localStorage.setItem(key, JSON.stringify(next.slice(0, 500)))
  } catch {
    // localStorage가 막힌 환경에서는 메뉴 동작만 조용히 닫는다.
  }
}

async function copyAddressToClipboard(address) {
  const text = address?.email || ''
  if (!text) return
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

function MailAddressMenu({ menu, onClose, onSearch, mt = MAIL_TEXT.ko }) {
  const { ref, style } = useAnchoredMenuPosition(menu?.x ?? 0, menu?.y ?? 0)
  if (!menu?.address?.email) return null
  const { address } = menu
  const itemClass = 'flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50'
  const am = mt.addressMenu
  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[210px] rounded-lg border border-gray-200 bg-white py-1 text-sm font-bold text-gray-700 shadow-xl shadow-gray-900/10"
      style={style}
      onClick={event => event.stopPropagation()}
    >
      <button
        type="button"
        className={itemClass}
        onClick={() => {
          window.location.href = `mailto:${encodeURIComponent(address.email)}`
          onClose()
        }}
      >
        <MenuIcon type="draft" />
        <span>{am.compose}</span>
      </button>
      <button
        type="button"
        className={itemClass}
        onClick={async () => {
          await copyAddressToClipboard(address)
          onClose()
        }}
      >
        <MenuIcon type="archive" />
        <span>{am.copy}</span>
      </button>
      <div className="my-1 border-t border-gray-100" />
      <button
        type="button"
        className={itemClass}
        onClick={() => {
          saveAddressListItem('easystation.mail.contacts', address)
          onClose()
        }}
      >
        <span className="w-4 text-center text-gray-400">+</span>
        <span>{am.addContact}</span>
      </button>
      <button
        type="button"
        className={itemClass}
        onClick={() => {
          saveAddressListItem('easystation.mail.vip', address)
          onClose()
        }}
      >
        <MenuIcon type="star" />
        <span>{am.addVip}</span>
      </button>
      <div className="my-1 border-t border-gray-100" />
      <button
        type="button"
        className={itemClass}
        onClick={() => {
          onSearch?.(address.email)
          onClose()
        }}
      >
        <MenuIcon type="search" />
        <span>{am.search}</span>
      </button>
    </div>
  )
}

function MailAddressButton({ address, onOpen }) {
  if (!address?.email && !address?.name) return null
  return (
    <button
      type="button"
      className="rounded px-1 font-semibold text-gray-600 transition hover:bg-indigo-50 hover:text-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-100"
      onClick={(event) => {
        event.stopPropagation()
        const rect = event.currentTarget.getBoundingClientRect()
        // 원좌표만 전달하고 위치 보정은 useAnchoredMenuPosition이 처리한다. (MailService.md 19.55)
        onOpen?.({
          address,
          x: rect.left,
          y: rect.bottom + 6,
        })
      }}
    >
      {formatAddress(address)}
    </button>
  )
}

function AddressRow({ label, addresses, onOpen }) {
  if (!addresses.length) return null
  return (
    <div className="flex flex-wrap items-baseline gap-x-1 gap-y-1">
      <span className="font-bold text-gray-700">{label}</span>
      {addresses.map((address, index) => (
        <span key={`${label}-${address.email || address.name}-${index}`} className="inline-flex items-baseline">
          <MailAddressButton address={address} onOpen={onOpen} />
          {index < addresses.length - 1 && <span className="text-gray-400">,</span>}
        </span>
      ))}
    </div>
  )
}

function MailReplyActionButton({ icon, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-11 items-center gap-2 rounded-md px-2 text-sm font-semibold text-gray-500 transition hover:bg-gray-50 hover:text-gray-800"
    >
      <MenuIcon type={icon} />
      <span>{label}</span>
    </button>
  )
}

function MailViewer({ message, loading, error, onAddressSearch, onMailAction, onSummaryUpdated, onCalendarEventOpen, targetLanguage = 'ko', mt = MAIL_TEXT.ko }) {
  const [addressMenu, setAddressMenu] = useState(null)
  const [summary, setSummary] = useState(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState('')
  const [summaryCopied, setSummaryCopied] = useState(false)
  const [summaryCopyError, setSummaryCopyError] = useState('')
  const [actionTimeDrafts, setActionTimeDrafts] = useState({})
  const [actionTimeSavingKey, setActionTimeSavingKey] = useState('')
  const [actionTimeError, setActionTimeError] = useState('')
  const [bodyFrameHeight, setBodyFrameHeight] = useState(560)
  const actionTimeDraftsRef = useRef({})

  useEffect(() => {
    if (!addressMenu) return undefined
    function closeMenu() {
      setAddressMenu(null)
    }
    function closeOnEscape(event) {
      if (event.key === 'Escape') closeMenu()
    }
    window.addEventListener('click', closeMenu)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [addressMenu])

  useEffect(() => {
    setSummary(normalizeMailSummary(message?.summary))
    setSummaryLoading(false)
    setSummaryError('')
    setSummaryCopied(false)
    setSummaryCopyError('')
    setActionTimeDrafts({})
    actionTimeDraftsRef.current = {}
    setActionTimeSavingKey('')
    setActionTimeError('')
    setBodyFrameHeight(560)
  }, [message?.id, message?.summary])

  function resizeBodyFrame(iframe) {
    if (!iframe) return
    try {
      const doc = iframe.contentDocument
      if (!doc) return
      if (doc.documentElement) doc.documentElement.style.overflow = 'hidden'
      if (doc.body) doc.body.style.overflow = 'hidden'
      const height = Math.max(
        560,
        doc.documentElement?.scrollHeight || 0,
        doc.body?.scrollHeight || 0,
        doc.documentElement?.offsetHeight || 0,
        doc.body?.offsetHeight || 0,
      )
      setBodyFrameHeight(height)
    } catch {
      setBodyFrameHeight(560)
    }
  }

  function handleBodyFrameLoad(event) {
    const iframe = event.currentTarget
    resizeBodyFrame(iframe)
    window.setTimeout(() => resizeBodyFrame(iframe), 250)
    window.setTimeout(() => resizeBodyFrame(iframe), 1000)
  }

  async function generateSummary() {
    if (!message?.id || !message?.tenant_id) return
    setSummaryLoading(true)
    setSummaryError('')
    setSummaryCopied(false)
    setSummaryCopyError('')
    try {
      const result = await apiFetch(`/mail/messages/${message.id}/summary`, {
        method: 'POST',
        body: JSON.stringify({ tenantId: message.tenant_id, targetLanguage }),
      })
      const structuredSummary = normalizeMailSummary(result?.summary)
      if (!structuredSummary) throw new Error(mt.summaryInvalid)
      setSummary(structuredSummary)
      onSummaryUpdated?.(structuredSummary)
    } catch (err) {
      setSummaryError(err.message || mt.summaryFailed)
    } finally {
      setSummaryLoading(false)
    }
  }

  async function copySummary() {
    if (!summary) return
    setSummaryCopyError('')
    const copied = await copyTextWithFallback(formatMailSummaryForCopy(summary, mt))
    if (copied) {
      setSummaryCopied(true)
      window.setTimeout(() => setSummaryCopied(false), 1800)
      return
    }
    setSummaryCopied(false)
    setSummaryCopyError(mt.copyFailed)
  }

  async function updateActionItemTime(index, patch) {
    if (!message?.id || !message?.tenant_id) return
    const key = String(index)
    const currentItem = summary?.actionItems?.[index] || {}
    const savedDateTime = parseSummaryActionDateTime(currentItem?.time)
    const nextDraft = {
      ...savedDateTime,
      isAllDay: currentItem?.isAllDay === true,
      ...(actionTimeDraftsRef.current[index] || {}),
      ...patch,
    }
    actionTimeDraftsRef.current = { ...actionTimeDraftsRef.current, [index]: nextDraft }
    setActionTimeDrafts(prev => ({ ...prev, [index]: nextDraft }))
    setActionTimeError('')
    if (!nextDraft.date || (!nextDraft.isAllDay && !nextDraft.time)) return

    setActionTimeSavingKey(key)
    try {
      const result = await apiFetch(`/mail/messages/${message.id}/summary/action-items/${index}/time`, {
        method: 'PATCH',
        body: JSON.stringify({
          tenantId: message.tenant_id,
          targetLanguage,
          date: nextDraft.date,
          time: nextDraft.isAllDay ? '' : nextDraft.time,
          isAllDay: nextDraft.isAllDay === true,
          createCalendarEvent: true,
        }),
      })
      const structuredSummary = normalizeMailSummary(result?.summary)
      if (!structuredSummary) throw new Error(mt.summaryInvalid)
      setSummary(structuredSummary)
      onSummaryUpdated?.(structuredSummary)
      const nextDrafts = { ...actionTimeDraftsRef.current }
      delete nextDrafts[index]
      actionTimeDraftsRef.current = nextDrafts
      setActionTimeDrafts(prev => {
        const next = { ...prev }
        delete next[index]
        return next
      })
    } catch (err) {
      setActionTimeError(err.message || mt.summary?.actionTimeFailed || 'Failed to save the action item time.')
    } finally {
      setActionTimeSavingKey('')
    }
  }

  if (loading) {
    return (
      <div className="flex h-full min-h-[360px] items-center justify-center px-8 text-sm font-bold text-gray-500">
        {mt.bodyLoading}
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex h-full min-h-[360px] items-center justify-center px-8 text-center text-sm font-bold text-red-600">
        {error}
      </div>
    )
  }
  if (!message) return <EmptyMailViewer mt={mt} />

  const fromAddresses = [{ name: message.from_name || '', email: message.from_email || '' }]
    .filter(item => item.name || item.email)
  const toAddresses = normalizeAddressList(message.to_json)
  const ccAddresses = normalizeAddressList(message.cc_json)
  const bodyHtml = message.body_html
    ? `<base target="_blank"><style>html,body{overflow:hidden!important;}</style>${message.body_html}`
    : ''

  return (
    <article className="min-h-full bg-white">
      <header className="border-b border-gray-100 px-6 py-5">
        <h2 className="text-xl font-extrabold leading-8 text-gray-900">
          {message.subject || mt.noSubject}
        </h2>
        <div className="mt-3 grid gap-1 text-sm text-gray-500">
          <AddressRow label={mt.from} addresses={fromAddresses} onOpen={setAddressMenu} />
          <AddressRow label={mt.to} addresses={toAddresses} onOpen={setAddressMenu} />
          <AddressRow label={mt.cc} addresses={ccAddresses} onOpen={setAddressMenu} />
          <div>
            <span className="font-bold text-gray-700">{mt.date}</span>{' '}
            {message.received_at ? new Date(message.received_at).toLocaleString() : '-'}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={generateSummary}
            disabled={summaryLoading}
            className="inline-flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-extrabold text-indigo-700 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <MenuIcon type="ai" />
            <span>{summaryLoading ? mt.regenerating : summary ? mt.regenerate : mt.summarize}</span>
          </button>
          {summary && (
            <button
              type="button"
              onClick={copySummary}
              className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-bold text-gray-600 transition hover:bg-gray-50 hover:text-gray-900"
            >
              {summaryCopied ? mt.copied : mt.copySummary}
            </button>
          )}
        </div>
        {summaryCopyError && (
          <p className="mt-2 text-xs font-bold text-red-500">{summaryCopyError}</p>
        )}
      </header>
      <div className="bg-white">
        {(summary || summaryError) && (
          <section className="border-b border-gray-100 px-6 py-5">
            {summaryError ? (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-600">{summaryError}</p>
            ) : (
              <MailSummaryPanel
                summary={summary}
                mt={mt}
                actionTimeDrafts={actionTimeDrafts}
                actionTimeSavingKey={actionTimeSavingKey}
                actionTimeError={actionTimeError}
                onActionTimeChange={updateActionItemTime}
                onCalendarEventOpen={onCalendarEventOpen}
              />
            )}
          </section>
        )}
        {message.body_html ? (
          <iframe
            title={mt.bodyLoading}
            sandbox="allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
            srcDoc={bodyHtml}
            scrolling="no"
            onLoad={handleBodyFrameLoad}
            style={{ height: bodyFrameHeight }}
            className="block w-full border-0 bg-white"
          />
        ) : (
          <pre className="whitespace-pre-wrap break-words px-6 py-5 text-sm leading-7 text-gray-800">
            {message.body_text || message.snippet || mt.noBody}
          </pre>
        )}
        {Array.isArray(message.attachments) && message.attachments.length > 0 && (
          <div className="border-t border-gray-100 px-6 py-4">
            <div className="mb-2 text-xs font-bold text-gray-500">
              {mt.attachmentCount(message.attachments.length)}
            </div>
            <div className="flex flex-wrap gap-2">
              {message.attachments.map(att => (
                <a
                  key={att.id}
                  href={`/api/mail/messages/${message.id}/attachments/${att.id}?tenantId=${encodeURIComponent(message.tenant_id || '')}`}
                  download={att.filename}
                  title={`${att.filename} (${formatFileSize(att.size_bytes)})`}
                  className="flex max-w-[240px] items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 hover:border-indigo-300 hover:bg-indigo-50"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21.44 11.05l-9.19 9.19a5 5 0 01-7.07-7.07l9.19-9.19a3 3 0 014.24 4.24l-9.2 9.19a1 1 0 01-1.41-1.41l8.49-8.49" />
                  </svg>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-bold text-gray-800">{att.filename}</span>
                    <span className="block text-[11px] text-gray-400">{formatFileSize(att.size_bytes)}</span>
                  </span>
                  <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0 text-indigo-500" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" />
                  </svg>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
      <footer className="flex items-center gap-6 border-t border-gray-100 px-6 py-4">
        <MailReplyActionButton icon="forward" label={mt.forward} onClick={() => onMailAction?.('forward', message)} />
        <MailReplyActionButton icon="reply" label={mt.replyAll} onClick={() => onMailAction?.('replyAll', message)} />
        <MailReplyActionButton icon="reply" label={mt.reply} onClick={() => onMailAction?.('reply', message)} />
      </footer>
      <MailAddressMenu
        menu={addressMenu}
        onClose={() => setAddressMenu(null)}
        onSearch={onAddressSearch}
        mt={mt}
      />
    </article>
  )
}

const FOLDER_COLOR_OPTIONS = [
  { key: '', label: '기본값', value: '' },
  { key: 'red', label: '빨강', value: '#ff4b55' },
  { key: 'orange', label: '주황', value: '#ff9f43' },
  { key: 'yellow', label: '노랑', value: '#ffd84d' },
  { key: 'green', label: '녹색', value: '#32e96b' },
  { key: 'blue', label: '파랑', value: '#3db7f2' },
  { key: 'purple', label: '퍼플', value: '#bf3df2' },
]

const FOLDER_COLOR_MAP = Object.fromEntries(FOLDER_COLOR_OPTIONS.map(item => [item.key, item.value]))

function getFolderColorLabel(option, mt = MAIL_TEXT.ko) {
  return mt.colors?.[option.key || 'default'] || option.label
}

// 색 미지정 스마트 폴더에 이름 기반으로 안정적인 색을 부여한다(MailService.md 18.10.2 ①).
// 같은 이름은 항상 같은 색 → 리로드/기기 간 일관. 사용자가 지정한 color_key가 있으면 그게 우선.
const AUTO_TAG_PALETTE = ['red', 'orange', 'yellow', 'green', 'blue', 'purple']
function autoTagColorKey(name) {
  let h = 0
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return AUTO_TAG_PALETTE[h % AUTO_TAG_PALETTE.length]
}
// 실제 표시 색(hex). color_key가 지정돼 있으면 그 색, 없으면 이름 해시 자동 색.
function resolveTagColor(colorKey, name) {
  return FOLDER_COLOR_MAP[colorKey || autoTagColorKey(name)] || ''
}

function getFolderDepth(folders, folder) {
  const byId = new Map((folders || []).map(item => [item.id, item]))
  let depth = 0
  let current = folder
  const seen = new Set()
  while (current?.parent_folder_id && byId.has(current.parent_folder_id) && !seen.has(current.parent_folder_id)) {
    seen.add(current.parent_folder_id)
    depth += 1
    current = byId.get(current.parent_folder_id)
  }
  return depth
}

const MAIL_FOLDER_TYPE_ORDER = {
  inbox: 0,
  sent: 1,
  drafts: 2,
  archive: 3,
  spam: 90,
  trash: 100,
}

function getFolderTypeOrder(folder = {}) {
  if (Object.prototype.hasOwnProperty.call(MAIL_FOLDER_TYPE_ORDER, folder?.type)) {
    return MAIL_FOLDER_TYPE_ORDER[folder.type]
  }
  return 50
}

function compareMailFolders(a = {}, b = {}, mt = MAIL_TEXT.ko) {
  const typeDelta = getFolderTypeOrder(a) - getFolderTypeOrder(b)
  if (typeDelta !== 0) return typeDelta
  const aLabel = getMailFolderLabel(a, mt)
  const bLabel = getMailFolderLabel(b, mt)
  const nameDelta = aLabel.localeCompare(bLabel, undefined, { numeric: true, sensitivity: 'base' })
  if (nameDelta !== 0) return nameDelta
  return String(a.id || a.name || '').localeCompare(String(b.id || b.name || ''))
}

function buildHierarchicalFolderList(folders = [], mt = MAIL_TEXT.ko) {
  const rows = Array.isArray(folders) ? folders.filter(Boolean) : []
  const ids = new Set(rows.map(folder => folder.id).filter(Boolean))
  const childrenByParent = new Map()
  const roots = []

  for (const folder of rows) {
    const parentId = folder.parent_folder_id || ''
    if (parentId && ids.has(parentId)) {
      const children = childrenByParent.get(parentId) || []
      children.push(folder)
      childrenByParent.set(parentId, children)
    } else {
      roots.push(folder)
    }
  }

  const ordered = []
  const visited = new Set()

  function appendBranch(folder, depth) {
    const key = folder.id || `${folder.name}-${ordered.length}`
    if (visited.has(key)) return
    visited.add(key)
    ordered.push({ folder, depth })

    const children = [...(childrenByParent.get(folder.id) || [])].sort((a, b) => compareMailFolders(a, b, mt))
    for (const child of children) appendBranch(child, depth + 1)
  }

  for (const folder of [...roots].sort((a, b) => compareMailFolders(a, b, mt))) {
    appendBranch(folder, 0)
  }

  for (const folder of rows) {
    const key = folder.id || `${folder.name}-${ordered.length}`
    if (!visited.has(key)) appendBranch(folder, 0)
  }

  return ordered
}

function isSystemMailFolder(folder) {
  return ['inbox', 'sent', 'drafts', 'trash', 'archive', 'spam'].includes(folder?.type)
}

function normalizeFolderName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function MailMenuButton({ active, icon, label, count, unreadCount, iconColor, onClick, onContextMenu, depth = 0, title, onDragOver, onDragLeave, onDrop, dropActive = false }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`flex items-center gap-2.5 w-full rounded-lg text-sm text-left transition-all ${
        depth ? 'px-2 py-1.5' : 'px-2 py-2'
      } ${
        dropActive
          ? 'bg-indigo-600 text-white shadow-lg ring-2 ring-inset ring-indigo-300'
          : active
            ? 'bg-indigo-600 text-white shadow-lg'
            : 'text-gray-500 hover:bg-gray-200 hover:text-gray-900'
      }`}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
    >
      <span style={active || !iconColor ? undefined : { color: iconColor }}>
        <MenuIcon type={icon} filled={!active && !!iconColor && icon === 'folder'} />
      </span>
      <span className="flex-1 font-medium truncate">{label}</span>
      <span className={`text-xs rounded-full px-1.5 py-0.5 font-bold min-w-[18px] text-center ${
        active ? 'bg-white/20 text-white' : 'bg-gray-300 text-gray-700'
      }`}>
        {`${Number(unreadCount || 0)} / ${Number(count || 0)}`}
      </span>
    </button>
  )
}

function FolderContextMenu({ menu, onClose, onCreateFolder, onCreateSubFolder, onRenameFolder, onDeleteFolder, onSetFolderColor, onEmptyTrash, mt = MAIL_TEXT.ko }) {
  const { ref, style } = useAnchoredMenuPosition(menu?.x ?? 0, menu?.y ?? 0)
  if (!menu?.folder) return null
  // deletable === false: 서버가 삭제를 거부한 폴더(네이버 자동분류함/서버 예약 메일함 등). (folder_delete_error.md 2번)
  const serverUndeletable = menu.folder.deletable === false
  const canDelete = !isSystemMailFolder(menu.folder) && !serverUndeletable
  const canRename = !isSystemMailFolder(menu.folder)
  const fm = mt.folderMenu
  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[210px] rounded-lg border border-gray-200 bg-white py-1 text-sm font-bold text-gray-700 shadow-xl shadow-gray-900/10"
      style={style}
      onClick={event => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => {
          onCreateFolder(menu)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
      >
        <span className="w-4 text-center text-gray-400">+</span>
        <span>{fm.add}</span>
      </button>
      <button
        type="button"
        onClick={() => {
          onCreateSubFolder(menu)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
      >
        <span className="w-4 text-center text-gray-400">↳</span>
        <span>{fm.addSub}</span>
      </button>
      <button
        type="button"
        disabled={!canRename}
        onClick={() => {
          if (!canRename) return
          onRenameFolder(menu)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300 disabled:hover:bg-white"
      >
        <span className="w-4 text-center text-gray-400">✎</span>
        <span>{fm.rename}</span>
      </button>
      <button
        type="button"
        disabled={!canDelete}
        title={serverUndeletable ? '이 메일함은 서버에서 삭제할 수 없습니다.' : undefined}
        onClick={() => {
          if (!canDelete) return
          onDeleteFolder(menu)
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-gray-300 disabled:hover:bg-white"
      >
        <MenuIcon type="trash" />
        <span>{fm.delete}</span>
      </button>
      {menu.folder.type === 'trash' && (
        <button
          type="button"
          onClick={() => {
            onEmptyTrash(menu)
            onClose()
          }}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-red-50"
        >
          <MenuIcon type="trash" />
          <span>{fm.emptyTrash}</span>
        </button>
      )}
      <div className="my-1 border-t border-gray-100" />
      <div className="px-3 py-2 text-xs font-extrabold text-gray-400">{fm.color}</div>
      {FOLDER_COLOR_OPTIONS.map(option => (
        <button
          key={option.key || 'default'}
          type="button"
          onClick={() => {
            onSetFolderColor(menu, option.key)
            onClose()
          }}
          className="flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-gray-50"
        >
          <span
            className="h-4 w-4 rounded-full border border-gray-200"
            style={{ backgroundColor: option.value || '#e5e7eb' }}
          />
          <span>{getFolderColorLabel(option, mt)}</span>
        </button>
      ))}
    </div>
  )
}

function UnifiedFolderContextMenu({ menu, onClose, onRefresh, onSetFolderColor, onEmptyUnifiedTrash, mt = MAIL_TEXT.ko }) {
  const { ref, style } = useAnchoredMenuPosition(menu?.x ?? 0, menu?.y ?? 0)
  if (!menu?.folder) return null
  const label = String(menu.folder.label || '').trim()
  const isTrash = String(menu.folder.type || '') === 'trash' || String(menu.folder.key || '') === 'trash'
  const fm = mt.folderMenu
  const disabledTitle = fm.disabledUnified
  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[210px] rounded-lg border border-gray-200 bg-white py-1 text-sm font-bold text-gray-700 shadow-xl shadow-gray-900/10"
      style={style}
      onClick={event => event.stopPropagation()}
    >
      {isTrash && (
        <>
          <button
            type="button"
            onClick={() => {
              onEmptyUnifiedTrash?.(menu.folder)
              onClose()
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-red-50"
          >
            <MenuIcon type="trash" />
            <span>{fm.emptyTrash}</span>
          </button>
          <div className="my-1 border-t border-gray-100" />
        </>
      )}
      <button
        type="button"
        onClick={() => {
          onRefresh()
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
      >
        <MenuIcon type="refresh" />
        <span>{mt.refresh}</span>
      </button>
      <button
        type="button"
        onClick={() => {
          if (label) navigator.clipboard?.writeText(label).catch(() => {})
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
      >
        <span className="w-4 text-center text-gray-400">⧉</span>
        <span>{fm.copyName}</span>
      </button>
      <div className="my-1 border-t border-gray-100" />
      <button
        type="button"
        disabled
        title={disabledTitle}
        className="flex w-full cursor-not-allowed items-center gap-2 px-3 py-2 text-left text-gray-300"
      >
        <span className="w-4 text-center">+</span>
        <span>{fm.add}</span>
      </button>
      <button
        type="button"
        disabled
        title={disabledTitle}
        className="flex w-full cursor-not-allowed items-center gap-2 px-3 py-2 text-left text-gray-300"
      >
        <span className="w-4 text-center">↳</span>
        <span>{fm.addSub}</span>
      </button>
      <button
        type="button"
        disabled
        title={disabledTitle}
        className="flex w-full cursor-not-allowed items-center gap-2 px-3 py-2 text-left text-gray-300"
      >
        <MenuIcon type="trash" />
        <span>{fm.delete}</span>
      </button>
      <div className="my-1 border-t border-gray-100" />
      <div className="px-3 py-2 text-xs font-extrabold text-gray-400">{fm.color}</div>
      {FOLDER_COLOR_OPTIONS.map(option => (
        <button
          key={option.key || 'default'}
          type="button"
          onClick={() => {
            onSetFolderColor(menu, option.key)
            onClose()
          }}
          className="flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-gray-50"
        >
          <span
            className="h-4 w-4 rounded-full border border-gray-200"
            style={{ backgroundColor: option.value || '#e5e7eb' }}
          />
          <span>{getFolderColorLabel(option, mt)}</span>
        </button>
      ))}
    </div>
  )
}

// 스마트 폴더(태그 기반 통합) 우클릭 메뉴 — 이름 변경 / 삭제 / 색상. (MailService.md 13)
function SmartFolderContextMenu({ menu, onClose, onRename, onDelete, onSetColor, mt = MAIL_TEXT.ko }) {
  const { ref, style } = useAnchoredMenuPosition(menu?.x ?? 0, menu?.y ?? 0)
  if (!menu?.folder) return null
  const fm = mt.folderMenu
  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[200px] rounded-lg border border-gray-200 bg-white py-1 text-sm font-bold text-gray-700 shadow-xl shadow-gray-900/10"
      style={style}
      onClick={event => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => { onRename(menu.folder); onClose() }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
      >
        <MenuIcon type="draft" />
        <span>{fm.rename}</span>
      </button>
      <button
        type="button"
        onClick={() => { onDelete(menu.folder); onClose() }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-red-50"
      >
        <MenuIcon type="trash" />
        <span>{fm.smartDelete}</span>
      </button>
      <div className="my-1 border-t border-gray-100" />
      <div className="px-3 py-2 text-xs font-extrabold text-gray-400">{fm.smartColor}</div>
      {FOLDER_COLOR_OPTIONS.map(option => (
        <button
          key={option.key || 'default'}
          type="button"
          onClick={() => { onSetColor(menu.folder, option.key); onClose() }}
          className="flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-gray-50"
        >
          <span
            className="h-4 w-4 rounded-full border border-gray-200"
            style={{ backgroundColor: option.value || '#e5e7eb' }}
          />
          <span>{getFolderColorLabel(option, mt)}</span>
        </button>
      ))}
    </div>
  )
}

function resolveMailBrand(provider, host = '') {
  if (provider === 'gmail' || provider === 'naver' || provider === 'apple') return provider
  const h = String(host || '').toLowerCase()
  if (h.includes('gmail') || h.includes('googlemail')) return 'gmail'
  if (h.includes('icloud') || h.includes('me.com')) return 'apple'
  if (h.includes('naver')) return 'naver'
  return 'other'
}

function ProviderLogo({ provider, host, size = 'md' }) {
  const brand = resolveMailBrand(provider, host)
  const boxClass = size === 'sm' ? 'h-5 w-5 rounded' : 'h-10 w-10 rounded-lg'
  const gmailClass = size === 'sm' ? 'h-3.5 w-4' : 'h-6 w-7'
  const appleClass = size === 'sm' ? 'h-3.5 w-3.5' : 'h-6 w-6'
  const mailClass = size === 'sm' ? 'h-3 w-3' : 'h-5 w-5'
  const naverTextClass = size === 'sm' ? 'text-[11px]' : 'text-lg'

  if (brand === 'gmail') {
    return (
      <span className={`flex ${boxClass} flex-shrink-0 items-center justify-center bg-white shadow-sm ring-1 ring-gray-200`}>
        <svg className={gmailClass} viewBox="0 0 28 22" aria-hidden="true">
          <path fill="#EA4335" d="M2.5 0h3L14 6.6 22.5 0h3v22h-5V8.5L14 13.5 7.5 8.5V22h-5V0z" />
          <path fill="#FBBC04" d="M2.5 0 14 8.9v4.6L2.5 4.6V0z" />
          <path fill="#34A853" d="M25.5 0 14 8.9v4.6L25.5 4.6V0z" />
          <path fill="#4285F4" d="M20.5 22V8.5l5-3.9V22h-5z" />
          <path fill="#C5221F" d="M2.5 22V4.6l5 3.9V22h-5z" />
        </svg>
      </span>
    )
  }
  if (brand === 'naver') {
    return (
      <span className={`flex ${boxClass} flex-shrink-0 items-center justify-center bg-[#03C75A] ${naverTextClass} font-black text-white shadow-sm`}>
        N
      </span>
    )
  }
  if (brand === 'apple') {
    return (
      <span className={`flex ${boxClass} flex-shrink-0 items-center justify-center bg-gray-950 text-white shadow-sm`}>
        <svg className={appleClass} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M16.5 1.8c.1 1.3-.4 2.5-1.2 3.4-.8.9-2.1 1.6-3.3 1.5-.1-1.2.4-2.5 1.1-3.3.9-1 2.3-1.7 3.4-1.6zM20.4 17.1c-.5 1.1-.8 1.6-1.5 2.6-1 1.5-2.4 3.3-4.1 3.3-1.5 0-1.9-1-4-1s-2.6 1-4 1c-1.7 0-3-1.7-4-3.2-2.8-4.2-3.1-9.1-1.4-11.7 1.2-1.8 3-2.8 4.7-2.8 1.8 0 2.9 1 4.3 1 1.4 0 2.3-1 4.4-1 1.6 0 3.3.9 4.5 2.4-4 2.2-3.3 7.9.7 9.4z" />
        </svg>
      </span>
    )
  }
  return (
    <span className={`flex ${boxClass} flex-shrink-0 items-center justify-center bg-indigo-50 text-indigo-500 shadow-sm ring-1 ring-indigo-100`}>
      <MailIcon className={mailClass} />
    </span>
  )
}

const NAVER_MAIL_DEFAULTS = {
  provider: 'naver',
  email_address: '',
  display_name: '',
  username: '',
  password: '',
  imap_host: 'imap.naver.com',
  imap_port: '993',
  imap_security: 'ssl',
  smtp_host: 'smtp.naver.com',
  smtp_port: '465',
  smtp_security: 'ssl',
}

// Gmail/iCloud는 OAuth 대신 기존 IMAP+앱비밀번호 경로(네이버와 동일)로 연결한다.
// provider는 백엔드 동기화 라우팅상 절대 'gmail'을 쓰면 안 됨(=OAuth로 잘못 라우팅).
// Gmail은 'other', iCloud는 'apple'(이미 IMAP provider로 허용됨)로 저장한다.
const GMAIL_IMAP_DEFAULTS = {
  provider: 'other',
  email_address: '',
  display_name: '',
  username: '',
  password: '',
  imap_host: 'imap.gmail.com',
  imap_port: '993',
  imap_security: 'ssl',
  smtp_host: 'smtp.gmail.com',
  smtp_port: '465',
  smtp_security: 'ssl',
}

const ICLOUD_MAIL_DEFAULTS = {
  provider: 'apple',
  email_address: '',
  display_name: '',
  username: '',
  password: '',
  imap_host: 'imap.mail.me.com',
  imap_port: '993',
  imap_security: 'ssl',
  smtp_host: 'smtp.mail.me.com',
  smtp_port: '587',
  smtp_security: 'starttls',
}

const OTHER_MAIL_DEFAULTS = {
  provider: 'imap',
  email_address: '',
  display_name: '',
  username: '',
  password: '',
  imap_host: '',
  imap_port: '993',
  imap_security: 'ssl',
  smtp_host: '',
  smtp_port: '587',
  smtp_security: 'starttls',
}

const MAIL_PRESETS = {
  naver: NAVER_MAIL_DEFAULTS,
  gmail: GMAIL_IMAP_DEFAULTS,
  apple: ICLOUD_MAIL_DEFAULTS,
  other: OTHER_MAIL_DEFAULTS,
}

const MAIL_PRESET_META = {
  naver: {
    title: '네이버 메일 클라이언트 설정',
    emailPlaceholder: 'name@naver.com',
    appPwLabel: '',
    appPwUrl: '',
    help: '네이버 메일 환경설정에서 IMAP/SMTP 사용을 켜고 앱 비밀번호를 입력하세요.',
  },
  gmail: {
    title: 'Gmail IMAP/SMTP 설정',
    emailPlaceholder: 'name@gmail.com',
    appPwLabel: 'Google 앱 비밀번호 발급',
    appPwUrl: 'https://myaccount.google.com/apppasswords',
    help: '2단계 인증을 켠 뒤 16자리 앱 비밀번호를 발급해 입력하세요. (계정 로그인 비밀번호가 아닙니다)',
  },
  apple: {
    title: 'iCloud 메일 설정',
    emailPlaceholder: 'name@icloud.com',
    appPwLabel: 'Apple 앱 암호 발급',
    appPwUrl: 'https://account.apple.com',
    help: 'account.apple.com → 로그인 및 보안 → 앱 암호에서 발급해 입력하세요.',
  },
  other: {
    title: 'IMAP/SMTP 직접 설정',
    emailPlaceholder: 'name@example.com',
    appPwLabel: '',
    appPwUrl: '',
    help: '메일 제공자의 IMAP/SMTP 서버 정보와 (필요 시) 앱 비밀번호를 입력하세요.',
  },
}

const IMAP_PROVIDER_KEYS = ['naver', 'apple', 'imap', 'other']

function isImapAccount(account) {
  return IMAP_PROVIDER_KEYS.includes(account?.provider)
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold text-gray-500">{label}</span>
      {children}
    </label>
  )
}

function MailInput(props) {
  return (
    <input
      {...props}
      className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-800 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
    />
  )
}

function MailSelect(props) {
  return (
    <select
      {...props}
      className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm font-bold text-gray-700 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
    />
  )
}

function SlideToggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors ${checked ? 'bg-indigo-600' : 'bg-gray-200'}`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`}
      />
    </button>
  )
}

function DetailValue({ label, value }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
      <span className="block text-[11px] font-bold text-gray-400">{label}</span>
      <span className="mt-1 block truncate text-sm font-bold text-gray-800">{value || '-'}</span>
    </div>
  )
}

function formatSecurity(value, mt = MAIL_TEXT.ko) {
  if (value === 'ssl') return 'SSL'
  if (value === 'starttls') return 'STARTTLS'
  if (value === 'none') return mt.none || '없음'
  return value || '-'
}

function getAccountLabel(account) {
  return account?.display_name || account?.email_address || ''
}

function getMailFolderLabel(folder = {}, mt = MAIL_TEXT.ko) {
  const rawName = String(folder?.name || '').trim()
  const normalized = rawName.toLowerCase()
  if (folder?.type && mt.folders?.[folder.type]) return mt.folders[folder.type]
  if (normalized === 'junk' || normalized === 'spam') return mt.folders.spam
  if (normalized === '받은 편지함') return mt.folders.inbox
  if (normalized === '보낸 메일') return mt.folders.sent
  if (normalized === '임시 보관함') return mt.folders.drafts
  if (normalized === '휴지통') return mt.folders.trash
  return rawName
}

function getMailFolderTitle(folder = {}, mt = MAIL_TEXT.ko) {
  if (folder?.sync_status === 'missing') return mt.folderMissingTitle
  if (folder?.is_local) {
    const label = getMailFolderLabel(folder, mt)
    return `${label} ${mt.localFolderTitle}`
  }
  return undefined
}

function isMailTrashFolder(folder = {}) {
  return folder?.type === 'trash'
    || String(folder?.provider_folder_id || '').toUpperCase() === 'TRASH'
    || String(folder?.name || '').trim() === '휴지통'
}

const EMPTY_MAILCLAW_FORM = {
  name: '',
  enabled: true,
  sender_check_enabled: false,
  sender_conditions_text: '',
  cc_check_enabled: false,
  cc_conditions_text: '',
  keyword_check_enabled: false,
  keyword_conditions_text: '',
  ai_analysis_enabled: true,
  forward_enabled: false,
  forward_addresses_text: '',
  move_folder_enabled: false,
  target_folder_id: '',
  tag_smart_folder_enabled: false,
  tag_smart_folder_id: '',
  tag_archive_enabled: false,
}

function splitLines(value) {
  return String(value || '')
    .split(/[,\n;]/)
    .map(item => item.trim())
    .filter(Boolean)
}

function joinLines(value) {
  return Array.isArray(value) ? value.join('\n') : ''
}

function mailClawRuleToForm(rule) {
  if (!rule) return { ...EMPTY_MAILCLAW_FORM }
  return {
    name: rule.name || '',
    enabled: rule.enabled !== false,
    sender_check_enabled: !!rule.sender_check_enabled,
    sender_conditions_text: joinLines(rule.sender_conditions),
    cc_check_enabled: !!rule.cc_check_enabled,
    cc_conditions_text: joinLines(rule.cc_conditions),
    keyword_check_enabled: !!rule.keyword_check_enabled,
    keyword_conditions_text: joinLines(rule.keyword_conditions),
    ai_analysis_enabled: !!rule.ai_analysis_enabled,
    forward_enabled: !!rule.forward_enabled,
    forward_addresses_text: joinLines(rule.forward_addresses),
    move_folder_enabled: !!rule.move_folder_enabled,
    target_folder_id: rule.target_folder_id || '',
    tag_smart_folder_enabled: !!rule.tag_smart_folder_enabled,
    tag_smart_folder_id: rule.tag_smart_folder_id || '',
    tag_archive_enabled: !!rule.tag_archive_enabled,
  }
}

function mailClawFormToPayload(form, tenantId) {
  return {
    tenantId,
    name: String(form.name || '').trim() || 'MailClaw',
    enabled: form.enabled !== false,
    sender_check_enabled: !!form.sender_check_enabled,
    sender_conditions: splitLines(form.sender_conditions_text),
    cc_check_enabled: !!form.cc_check_enabled,
    cc_conditions: splitLines(form.cc_conditions_text),
    keyword_check_enabled: !!form.keyword_check_enabled,
    keyword_conditions: splitLines(form.keyword_conditions_text),
    ai_analysis_enabled: !!form.ai_analysis_enabled,
    forward_enabled: !!form.forward_enabled,
    forward_addresses: splitLines(form.forward_addresses_text),
    move_folder_enabled: !!form.move_folder_enabled,
    target_folder_id: form.target_folder_id || null,
    tag_smart_folder_enabled: !!form.tag_smart_folder_enabled,
    tag_smart_folder_id: form.tag_smart_folder_id || null,
    tag_archive_enabled: !!form.tag_archive_enabled,
  }
}

function MailAccountManageModal({ accounts, tenants = [], activeFolder, activeUnified, currentTenantId, initialMailClawRegistration, onClose, onAccountAdded, onMailDataChanged, mt = MAIL_TEXT.ko }) {
  const [view, setView] = useState('main')
  const [selectedAccount, setSelectedAccount] = useState(null)
  const [accountEditMode, setAccountEditMode] = useState(false)
  const [accountEditForm, setAccountEditForm] = useState(null)
  const [accountSaving, setAccountSaving] = useState(false)
  const [accountError, setAccountError] = useState('')
  const [gmailAuthLoading, setGmailAuthLoading] = useState(false)
  const [gmailAuthError, setGmailAuthError] = useState('')
  // naverForm/imapBrand는 네이버 전용이 아니라 공용 IMAP 폼 상태로 재사용한다.
  const [naverForm, setNaverForm] = useState(NAVER_MAIL_DEFAULTS)
  const [imapBrand, setImapBrand] = useState('naver')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [naverSaving, setNaverSaving] = useState(false)
  const [naverError, setNaverError] = useState('')
  const [mailClawTenantId, setMailClawTenantId] = useState(accounts[0]?.tenant_id || tenants[0]?.id || '')
  const [mailClawRules, setMailClawRules] = useState([])
  const [mailClawSmartFolders, setMailClawSmartFolders] = useState([])
  const [mailClawLogs, setMailClawLogs] = useState([])
  const [mailClawSelectedRule, setMailClawSelectedRule] = useState(null)
  const [mailClawForm, setMailClawForm] = useState({ ...EMPTY_MAILCLAW_FORM })
  const [mailClawLoading, setMailClawLoading] = useState(false)
  const [mailClawSaving, setMailClawSaving] = useState(false)
  const [mailClawApplying, setMailClawApplying] = useState(false)
  const [mailClawApplyProgress, setMailClawApplyProgress] = useState(null)
  const [mailClawError, setMailClawError] = useState('')
  // 첨부파일 정책 (MailService.md 10.8) — 편집은 사이트 관리자만.
  const { currentUser } = useAuth()
  const isSiteAdmin = currentUser?.role === 'site_admin'
  const [attachPolicyForm, setAttachPolicyForm] = useState(null)
  const [attachPolicyLoading, setAttachPolicyLoading] = useState(false)
  const [attachPolicySaving, setAttachPolicySaving] = useState(false)
  const [attachPolicyError, setAttachPolicyError] = useState('')
  const [attachPolicyStatus, setAttachPolicyStatus] = useState('')
  const providers = [
    { key: 'gmail', label: 'Gmail 계정 추가', hint: 'IMAP + 앱 비밀번호로 연결합니다.' },
    { key: 'naver', label: '네이버 계정 추가', hint: '네이버 메일 IMAP/SMTP 설정으로 진행합니다.' },
    { key: 'apple', label: 'Apple iCloud 계정 추가', hint: 'iCloud 앱 암호 + IMAP으로 연결합니다.' },
    { key: 'other', label: '기타 계정 추가', hint: 'IMAP/SMTP 서버 정보를 직접 입력합니다.' },
  ]

  function openImapPreset(key) {
    const presetKey = MAIL_PRESETS[key] ? key : 'other'
    setImapBrand(presetKey)
    setNaverForm({ ...MAIL_PRESETS[presetKey] })
    setNaverError('')
    setShowAdvanced(false)
    setView('imap')
  }

  // Gmail/iCloud/네이버는 서버값이 프리셋으로 채워져 있어 기본 화면에서 숨긴다(고급 설정에서만 노출).
  // 기타(other)는 서버를 직접 입력해야 하므로 항상 노출한다.
  const hasPresetServers = imapBrand !== 'other' && Boolean(naverForm.imap_host && naverForm.smtp_host)

  const mailClawActiveTenantId = activeFolder?.account?.tenant_id || currentTenantId || ''
  const mailClawTenantAccounts = accounts
    .filter(account => !mailClawTenantId || account.tenant_id === mailClawTenantId)
  const mailClawTrashFolders = mailClawTenantAccounts
    .flatMap(account => (account.folders || []).filter(isMailTrashFolder))
    .filter(folder => folder.id)
  const mailClawSelectedTrashFolder = mailClawTrashFolders
    .find(folder => folder.id === mailClawForm.target_folder_id)
  const mailClawGenericTrashFolder = mailClawSelectedTrashFolder || mailClawTrashFolders[0] || null
  const mailClawFolders = [
    ...(mailClawGenericTrashFolder ? [{ id: mailClawGenericTrashFolder.id, label: '휴지통' }] : []),
    ...mailClawTenantAccounts.flatMap(account => (account.folders || [])
      .filter(folder => !isMailTrashFolder(folder))
      .map(folder => ({
        id: folder.id,
        label: `${getAccountLabel(account)} / ${getMailFolderLabel(folder)}`,
      }))),
  ]
    .filter(folder => folder.id)
  const mailClawActiveScopeLabel = activeFolder?.folder?.id
    ? `${getAccountLabel(activeFolder.account)} / ${getMailFolderLabel(activeFolder.folder)}`
    : activeUnified?.label || ''
  const hasMailClawActiveScope = Boolean(activeFolder?.folder?.id || activeUnified?.key)

  useEffect(() => {
    if (!mailClawTenantId && accounts[0]?.tenant_id) setMailClawTenantId(accounts[0].tenant_id)
  }, [accounts, mailClawTenantId])

  async function loadMailClawData(tenantId = mailClawTenantId) {
    if (!tenantId) return
    setMailClawLoading(true)
    setMailClawError('')
    try {
      const params = new URLSearchParams({ tenantId })
      const [rules, logs, smart] = await Promise.all([
        apiFetch(`/mail/mailclaw/rules?${params.toString()}`),
        apiFetch(`/mail/mailclaw/logs?${params.toString()}&limit=20`),
        apiFetch(`/mail/smart-folders?${params.toString()}`).catch(() => []),
      ])
      setMailClawRules(Array.isArray(rules) ? rules : [])
      setMailClawLogs(Array.isArray(logs) ? logs : [])
      setMailClawSmartFolders(Array.isArray(smart) ? smart : [])
    } catch (err) {
      setMailClawError(err.message || 'MailClaw 정보를 불러오지 못했습니다.')
    } finally {
      setMailClawLoading(false)
    }
  }

  useEffect(() => {
    if (!initialMailClawRegistration?.senderEmail) return
    const tenantId = initialMailClawRegistration.tenantId || mailClawTenantId || accounts[0]?.tenant_id || tenants[0]?.id || ''
    const senderEmail = initialMailClawRegistration.senderEmail
    setMailClawTenantId(tenantId)
    if (initialMailClawRegistration.rule) {
      setMailClawSelectedRule(initialMailClawRegistration.rule)
      setMailClawForm(mailClawRuleToForm(initialMailClawRegistration.rule))
    } else {
      setMailClawSelectedRule(null)
      setMailClawForm({
        ...EMPTY_MAILCLAW_FORM,
        name: `MailClaw ${senderEmail}`,
        sender_check_enabled: true,
        sender_conditions_text: senderEmail,
      })
    }
    setMailClawApplyProgress(null)
    setMailClawError('')
    setView('mailclawEdit')
    if (tenantId) loadMailClawData(tenantId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMailClawRegistration?.id])

  function openMailClaw() {
    const tenantId = mailClawTenantId || accounts[0]?.tenant_id || tenants[0]?.id || ''
    setMailClawTenantId(tenantId)
    setMailClawSelectedRule(null)
    setMailClawForm({ ...EMPTY_MAILCLAW_FORM })
    setMailClawApplyProgress(null)
    setView('mailclaw')
    if (tenantId) loadMailClawData(tenantId)
  }

  // 첨부파일 정책 (MailService.md 10.8)
  async function openAttachPolicy() {
    setView('attachPolicy')
    setAttachPolicyError('')
    setAttachPolicyStatus('')
    setAttachPolicyLoading(true)
    try {
      const p = await apiFetch('/mail/attachment-policy')
      setAttachPolicyForm({
        max_file_mb: p?.max_file_mb ?? 25,
        max_total_mb: p?.max_total_mb ?? 25,
        max_files: p?.max_files ?? 20,
        blocked_extensions: Array.isArray(p?.blocked_extensions) ? p.blocked_extensions.join(', ') : '',
      })
    } catch (err) {
      setAttachPolicyError(err.message || '첨부파일 정책을 불러오지 못했습니다.')
    } finally {
      setAttachPolicyLoading(false)
    }
  }

  async function saveAttachPolicy(event) {
    event.preventDefault()
    if (!isSiteAdmin || !attachPolicyForm) return
    setAttachPolicySaving(true)
    setAttachPolicyError('')
    setAttachPolicyStatus('')
    try {
      const saved = await apiFetch('/mail/attachment-policy', {
        method: 'PUT',
        body: JSON.stringify({
          max_file_mb: Number(attachPolicyForm.max_file_mb),
          max_total_mb: Number(attachPolicyForm.max_total_mb),
          max_files: Number(attachPolicyForm.max_files),
          blocked_extensions: attachPolicyForm.blocked_extensions,
        }),
      })
      setAttachPolicyForm({
        max_file_mb: saved.max_file_mb,
        max_total_mb: saved.max_total_mb,
        max_files: saved.max_files,
        blocked_extensions: (saved.blocked_extensions || []).join(', '),
      })
      setAttachPolicyStatus('첨부파일 정책을 저장했습니다.')
    } catch (err) {
      setAttachPolicyError(err.message || '첨부파일 정책을 저장하지 못했습니다.')
    } finally {
      setAttachPolicySaving(false)
    }
  }

  function editMailClawRule(rule) {
    setMailClawSelectedRule(rule)
    setMailClawForm(mailClawRuleToForm(rule))
    setMailClawApplyProgress(null)
    setView('mailclawEdit')
  }

  function newMailClawRule() {
    setMailClawSelectedRule(null)
    setMailClawForm({ ...EMPTY_MAILCLAW_FORM, name: `MailClaw #${mailClawRules.length + 1}` })
    setMailClawApplyProgress(null)
    setView('mailclawEdit')
  }

  function updateMailClawField(key, value) {
    setMailClawForm(prev => ({ ...prev, [key]: value }))
  }

  function validateMailClawPayload(payload) {
    if (payload.sender_check_enabled && payload.sender_conditions.length === 0) throw new Error('발신자 조건을 입력해주세요.')
    if (payload.cc_check_enabled && payload.cc_conditions.length === 0) throw new Error('참조자 조건을 입력해주세요.')
    if (payload.keyword_check_enabled && payload.keyword_conditions.length === 0) throw new Error('키워드 조건을 입력해주세요.')
    if (payload.forward_enabled && payload.forward_addresses.length === 0) throw new Error('전달할 메일 주소를 입력해주세요.')
    if (payload.move_folder_enabled && !payload.target_folder_id) throw new Error('이동할 폴더를 선택해주세요.')
    if (payload.move_folder_enabled && !mailClawFolders.some(folder => folder.id === payload.target_folder_id)) throw new Error('이동할 폴더를 선택해주세요.')
    if (payload.tag_smart_folder_enabled && !payload.tag_smart_folder_id) throw new Error('태그할 스마트 폴더를 선택해주세요.')
  }

  async function persistMailClawRule() {
    if (!mailClawTenantId) {
      throw new Error('MailClaw를 저장할 메일 공간을 선택해주세요.')
    }
    const payload = mailClawFormToPayload(mailClawForm, mailClawTenantId)
    validateMailClawPayload(payload)
    const url = mailClawSelectedRule
      ? `/mail/mailclaw/rules/${mailClawSelectedRule.id}`
      : '/mail/mailclaw/rules'
    const rule = await apiFetch(url, {
      method: mailClawSelectedRule ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    })
    setMailClawSelectedRule(rule)
    return rule
  }

  async function saveMailClawRule(event) {
    event.preventDefault()
    setMailClawSaving(true)
    setMailClawError('')
    try {
      await persistMailClawRule()
      await loadMailClawData(mailClawTenantId)
      setView('mailclaw')
    } catch (err) {
      setMailClawError(err.message || 'MailClaw 규칙을 저장하지 못했습니다.')
    } finally {
      setMailClawSaving(false)
    }
  }

  async function deleteMailClawRule(rule) {
    if (!rule || !mailClawTenantId) return
    if (!window.confirm(`'${rule.name}' MailClaw 규칙을 삭제할까요?`)) return
    setMailClawSaving(true)
    setMailClawError('')
    try {
      const params = new URLSearchParams({ tenantId: mailClawTenantId })
      await apiFetch(`/mail/mailclaw/rules/${rule.id}?${params.toString()}`, { method: 'DELETE' })
      await loadMailClawData(mailClawTenantId)
    } catch (err) {
      setMailClawError(err.message || 'MailClaw 규칙을 삭제하지 못했습니다.')
    } finally {
      setMailClawSaving(false)
    }
  }

  async function fetchCurrentFolderMessageIds() {
    if (!activeFolder?.folder?.id && !activeUnified?.key) return []
    const ids = []
    const pageSize = 200
    let offset = 0
    while (true) {
      const params = activeFolder?.folder?.id
        ? new URLSearchParams({
            tenantId: activeFolder.account.tenant_id,
            accountId: activeFolder.account.id,
            folderId: activeFolder.folder.id,
            limit: String(pageSize),
            offset: String(offset),
          })
        : new URLSearchParams({
            tenantId: mailClawActiveTenantId,
            scope: 'unified',
            unifiedKey: activeUnified.key,
            folderType: activeUnified.type || '',
            folderName: activeUnified.folderName || '',
            limit: String(pageSize),
            offset: String(offset),
          })
      const rows = await apiFetch(`/mail/messages?${params.toString()}`)
      const list = Array.isArray(rows) ? rows : []
      ids.push(...list.map(item => item.id).filter(Boolean))
      if (list.length < pageSize) break
      offset += pageSize
    }
    return [...new Set(ids)]
  }

  async function applySelectedMailClawToCurrentFolder() {
    if (!hasMailClawActiveScope || !mailClawActiveTenantId) {
      setMailClawError('현재 선택된 폴더가 없습니다.')
      return
    }
    if (mailClawTenantId !== mailClawActiveTenantId) {
      setMailClawError('선택된 MailClaw와 현재 폴더의 메일 공간이 다릅니다.')
      return
    }
    setMailClawApplying(true)
    setMailClawError('')
    setMailClawApplyProgress({
      phase: 'collecting',
      total: 0,
      done: 0,
      matched: 0,
      skipped: 0,
      failed: 0,
      current: '현재 폴더의 메일을 확인하는 중...',
    })
    try {
      setMailClawApplyProgress(prev => ({
        ...(prev || {}),
        current: mailClawSelectedRule?.id ? 'MailClaw 적용 준비 중...' : 'MailClaw를 먼저 저장하는 중...',
      }))
      const rule = await persistMailClawRule()
      const ruleId = rule?.id || mailClawSelectedRule?.id
      if (!ruleId) throw new Error('MailClaw 규칙을 저장하지 못했습니다.')
      const messageIds = await fetchCurrentFolderMessageIds()
      setMailClawApplyProgress(prev => ({
        ...(prev || {}),
        phase: 'applying',
        total: messageIds.length,
        done: 0,
        current: messageIds.length ? 'MailClaw 적용을 시작합니다.' : '적용할 메일이 없습니다.',
      }))

      if (messageIds.length > 0) {
        // 폴더 전체를 서버측 배치 엔드포인트로 한 번에 처리하고, 진행 상황을
        // NDJSON 스트림으로 받아 표시한다. (건당 왕복 → 스트림 1회)
        const res = await fetch(`/api/mail/mailclaw/rules/${ruleId}/apply-messages`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenantId: mailClawActiveTenantId,
            messageIds,
            force: true,
          }),
        })
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error || `HTTP ${res.status}`)
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        const applyProgress = (evt) => {
          if (!evt || typeof evt !== 'object') return
          if (evt.type === 'error') throw new Error(evt.error || 'MailClaw 적용 중 오류가 발생했습니다.')
          const total = evt.total ?? messageIds.length
          const done = evt.done ?? 0
          setMailClawApplyProgress(prev => ({
            ...(prev || {}),
            phase: evt.type === 'done' ? 'done' : 'applying',
            total,
            done,
            matched: evt.matched ?? prev?.matched ?? 0,
            skipped: evt.skipped ?? prev?.skipped ?? 0,
            failed: evt.failed ?? prev?.failed ?? 0,
            current: evt.type === 'done'
              ? '현재 폴더 적용 완료'
              : `${done} / ${total} 처리 중`,
          }))
        }
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let newlineIndex
          while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newlineIndex).trim()
            buffer = buffer.slice(newlineIndex + 1)
            if (line) applyProgress(JSON.parse(line))
          }
        }
        const tail = buffer.trim()
        if (tail) applyProgress(JSON.parse(tail))
      }
      setMailClawApplyProgress(prev => ({
        ...(prev || {}),
        phase: 'done',
        current: '현재 폴더 적용 완료',
      }))
      await loadMailClawData(mailClawTenantId)
      setMailClawSelectedRule(prev => prev?.id === ruleId ? prev : rule)
      if (onMailDataChanged) await onMailDataChanged()
    } catch (err) {
      setMailClawError(err.message || '현재 폴더에 MailClaw를 적용하지 못했습니다.')
      setMailClawApplyProgress(prev => ({
        ...(prev || {}),
        phase: 'failed',
        current: '적용 실패',
      }))
    } finally {
      setMailClawApplying(false)
    }
  }

  async function startGmailAuth() {
    setGmailAuthLoading(true)
    setGmailAuthError('')
    try {
      const data = await apiFetch('/mail/gmail/auth-url')
      if (!data?.authUrl) throw new Error('Google 인증 URL을 받지 못했습니다.')
      window.location.href = data.authUrl
    } catch (err) {
      setGmailAuthError(err.message || 'Google 인증을 시작하지 못했습니다.')
      setGmailAuthLoading(false)
    }
  }

  function updateNaverField(key, value) {
    setNaverForm(prev => {
      const next = { ...prev, [key]: value }
      if (key === 'email_address' && (!prev.username || prev.username === prev.email_address)) {
        next.username = value
      }
      return next
    })
  }

  function accountToEditForm(account) {
    return {
      email_address: account.email_address || '',
      display_name: account.display_name || '',
      username: account.username || account.email_address || '',
      password: '',
      imap_host: account.imap_host || NAVER_MAIL_DEFAULTS.imap_host,
      imap_port: String(account.imap_port || NAVER_MAIL_DEFAULTS.imap_port),
      imap_security: account.imap_security || NAVER_MAIL_DEFAULTS.imap_security,
      smtp_host: account.smtp_host || NAVER_MAIL_DEFAULTS.smtp_host,
      smtp_port: String(account.smtp_port || NAVER_MAIL_DEFAULTS.smtp_port),
      smtp_security: account.smtp_security || NAVER_MAIL_DEFAULTS.smtp_security,
    }
  }

  function openAccountDetail(account) {
    setSelectedAccount(account)
    setAccountEditMode(false)
    setAccountEditForm(accountToEditForm(account))
    setAccountError('')
    setView('accountDetail')
  }

  function updateAccountEditField(key, value) {
    setAccountEditForm(prev => ({ ...(prev || {}), [key]: value }))
  }

  async function saveAccountEdit(event) {
    event.preventDefault()
    if (!selectedAccount || !accountEditForm) return
    setAccountSaving(true)
    setAccountError('')
    try {
      // Gmail/iCloud(호스트로 판별)는 인증 username을 항상 이메일로 강제. 앱비번 공백 제거.
      const editHost = String(accountEditForm.imap_host || '').toLowerCase()
      const forceEmailUser = editHost.includes('gmail') || editHost.includes('icloud') || editHost.includes('me.com')
      const data = await apiFetch(`/mail/accounts/${selectedAccount.id}/imap`, {
        method: 'PUT',
        body: JSON.stringify({
          ...accountEditForm,
          username: forceEmailUser ? accountEditForm.email_address : accountEditForm.username,
          password: (accountEditForm.password || '').replace(/\s+/g, ''),
          tenantId: selectedAccount.tenant_id,
          imap_port: Number(accountEditForm.imap_port),
          smtp_port: Number(accountEditForm.smtp_port),
        }),
      })
      const updatedAccount = {
        ...selectedAccount,
        ...(data.account || {}),
        tenant_name: selectedAccount.tenant_name,
      }
      setSelectedAccount(updatedAccount)
      setAccountEditForm(accountToEditForm(updatedAccount))
      setAccountEditMode(false)
      if (onAccountAdded) await onAccountAdded()
    } catch (err) {
      setAccountError(err.message || '메일 계정 설정을 저장하지 못했습니다.')
    } finally {
      setAccountSaving(false)
    }
  }

  async function saveNaverAccount(event) {
    event.preventDefault()
    setNaverSaving(true)
    setNaverError('')
    try {
      // Gmail/iCloud는 IMAP 인증 username이 반드시 전체 이메일이어야 한다.
      // 사용자가 입력하는 이름은 표시용(display_name, 왼쪽 탭 라벨)일 뿐 인증에는 쓰지 않는다.
      // 앱 비밀번호는 표시 포맷의 공백을 제거해 보낸다.
      const usernameForAuth = (imapBrand === 'gmail' || imapBrand === 'apple')
        ? naverForm.email_address
        : naverForm.username
      await apiFetch('/mail/accounts/imap', {
        method: 'POST',
        body: JSON.stringify({
          ...naverForm,
          username: usernameForAuth,
          password: (naverForm.password || '').replace(/\s+/g, ''),
          tenantId: naverForm.tenantId || undefined,
          imap_port: Number(naverForm.imap_port),
          smtp_port: Number(naverForm.smtp_port),
        }),
      })
      if (onAccountAdded) await onAccountAdded()
      onClose()
    } catch (err) {
      setNaverError(err.message || '네이버 메일 계정을 저장하지 못했습니다.')
    } finally {
      setNaverSaving(false)
    }
  }

  async function deleteAccount() {
    if (!selectedAccount) return
    const label = getAccountLabel(selectedAccount) || selectedAccount.email_address
    const ok = window.confirm(`'${label}' 계정 연동을 해제할까요?\n동기화된 받은메일·보낸메일·첨부 등 이 계정의 모든 데이터가 삭제됩니다.`)
    if (!ok) return
    setAccountSaving(true)
    setAccountError('')
    try {
      const params = new URLSearchParams({ tenantId: selectedAccount.tenant_id })
      await apiFetch(`/mail/accounts/${selectedAccount.id}?${params.toString()}`, { method: 'DELETE' })
      if (onAccountAdded) await onAccountAdded()
      setSelectedAccount(null)
      setView('manage')
    } catch (err) {
      setAccountError(err.message || '계정 연동 해제에 실패했습니다.')
    } finally {
      setAccountSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-5xl overflow-hidden rounded-lg bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-extrabold text-gray-900">메일 계정 관리</h2>
            <p className="mt-0.5 text-sm text-gray-400">
              {view === 'imap' ? '메일 클라이언트(IMAP/SMTP) 정보를 입력하세요.' : view === 'accountDetail' ? '메일 계정 설정 정보를 확인하세요.' : view === 'add' ? '추가할 메일 서비스를 선택하세요.' : view === 'manage' ? '관리할 계정을 선택하세요.' : view === 'mailclaw' || view === 'mailclawEdit' ? '수신 메일 자동화 조건과 동작을 관리하세요.' : view === 'attachPolicy' ? '첨부 용량·개수 상한과 차단 확장자를 설정하세요.' : '계정 추가 또는 관리 작업을 선택하세요.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            aria-label="닫기"
          >
            ×
          </button>
        </div>

        <div className="p-6">
          {view === 'main' && (
            <div className="grid gap-3">
              <button
                type="button"
                onClick={() => setView('add')}
                className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50"
              >
                <span>
                  <span className="block text-sm font-extrabold text-gray-900">계정 추가</span>
                  <span className="mt-0.5 block text-xs text-gray-500">Gmail, 네이버, Apple 또는 기타 계정을 추가합니다.</span>
                </span>
                <MenuIcon type="chevronRight" />
              </button>
              <button
                type="button"
                onClick={() => setView('manage')}
                className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50"
              >
                <span>
                  <span className="block text-sm font-extrabold text-gray-900">계정 관리</span>
                  <span className="mt-0.5 block text-xs text-gray-500">등록된 메일 계정을 관리합니다.</span>
                </span>
                <MenuIcon type="chevronRight" />
              </button>
              <button
                type="button"
                onClick={openMailClaw}
                className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <img src="/img/mail/mailclaw-character.png" alt="" className="h-10 w-10 flex-shrink-0 object-contain" />
                  <span className="min-w-0">
                    <span className="block text-sm font-extrabold text-gray-900">MailClaw</span>
                    <span className="mt-0.5 block text-xs text-gray-500">수신 메일 자동화 조건과 동작을 관리합니다.</span>
                  </span>
                </span>
                <MenuIcon type="chevronRight" />
              </button>
              <button
                type="button"
                onClick={openAttachPolicy}
                className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50"
              >
                <span>
                  <span className="block text-sm font-extrabold text-gray-900">첨부파일 정책</span>
                  <span className="mt-0.5 block text-xs text-gray-500">첨부 용량·개수 상한과 차단 확장자를 설정합니다.</span>
                </span>
                <MenuIcon type="chevronRight" />
              </button>
            </div>
          )}

          {view === 'attachPolicy' && (
            <div className="grid gap-4">
              {attachPolicyError && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-600">{attachPolicyError}</p>
              )}
              {attachPolicyStatus && (
                <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-700">{attachPolicyStatus}</p>
              )}
              {!isSiteAdmin && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
                  값은 조회만 가능합니다. 첨부파일 정책은 사이트 관리자만 변경할 수 있습니다.
                </p>
              )}
              <p className="rounded-lg bg-indigo-50 px-3 py-2 text-xs font-bold text-indigo-700">
                Gmail 등 대부분의 제공자는 메일 1건 한도가 약 25MB이며, 전송 시 base64 인코딩으로 크기가 약 37% 늘어납니다. 합계는 원본 기준 20MB 이하를 권장합니다.
              </p>
              {attachPolicyLoading || !attachPolicyForm ? (
                <p className="py-6 text-center text-sm font-bold text-gray-500">불러오는 중...</p>
              ) : (
                <form onSubmit={saveAttachPolicy} className="grid gap-4">
                  <div className="grid grid-cols-3 gap-3">
                    <label className="block">
                      <span className="mb-1 block text-xs font-extrabold text-gray-600">단일 파일 최대(MB)</span>
                      <input
                        type="number" min="1" max="200"
                        value={attachPolicyForm.max_file_mb}
                        disabled={!isSiteAdmin}
                        onChange={e => setAttachPolicyForm(prev => ({ ...prev, max_file_mb: e.target.value }))}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-extrabold text-gray-600">합계 최대(MB)</span>
                      <input
                        type="number" min="1" max="200"
                        value={attachPolicyForm.max_total_mb}
                        disabled={!isSiteAdmin}
                        onChange={e => setAttachPolicyForm(prev => ({ ...prev, max_total_mb: e.target.value }))}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-extrabold text-gray-600">최대 개수</span>
                      <input
                        type="number" min="1" max="100"
                        value={attachPolicyForm.max_files}
                        disabled={!isSiteAdmin}
                        onChange={e => setAttachPolicyForm(prev => ({ ...prev, max_files: e.target.value }))}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400"
                      />
                    </label>
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-xs font-extrabold text-gray-600">차단 확장자 (콤마로 구분)</span>
                    <textarea
                      rows={3}
                      value={attachPolicyForm.blocked_extensions}
                      disabled={!isSiteAdmin}
                      placeholder="exe, bat, cmd, com, scr, js, vbs, jar, msi"
                      onChange={e => setAttachPolicyForm(prev => ({ ...prev, blocked_extensions: e.target.value }))}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400"
                    />
                    <span className="mt-1 block text-xs text-gray-400">여기 등록한 확장자의 첨부는 보내기에서 거부됩니다.</span>
                  </label>
                  {isSiteAdmin && (
                    <div className="flex justify-end">
                      <button
                        type="submit"
                        disabled={attachPolicySaving}
                        className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-extrabold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-500 disabled:opacity-60"
                      >
                        {attachPolicySaving ? '저장 중...' : '저장'}
                      </button>
                    </div>
                  )}
                </form>
              )}
            </div>
          )}

          {view === 'add' && (
            <div className="grid gap-3">
              {providers.map(provider => (
                <button
                  key={provider.key}
                  type="button"
                  onClick={() => openImapPreset(provider.key)}
                  className="flex items-center gap-3 rounded-lg border border-gray-200 px-4 py-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50"
                >
                  <ProviderLogo provider={provider.key} />
                  <span className="min-w-0">
                    <span className="block text-sm font-extrabold text-gray-900">{provider.label}</span>
                    <span className="mt-0.5 block text-xs text-gray-500">{provider.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {view === 'imap' && (
            <form onSubmit={saveNaverAccount} className="grid gap-4">
              <div className="flex items-center gap-3 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3">
                <ProviderLogo provider={imapBrand} />
                <div className="min-w-0">
                  <h3 className="text-sm font-extrabold text-gray-900">{MAIL_PRESET_META[imapBrand]?.title || 'IMAP/SMTP 설정'}</h3>
                  <p className="mt-0.5 text-xs text-gray-500">{MAIL_PRESET_META[imapBrand]?.help || 'IMAP/SMTP 서버 값을 입력하세요.'}</p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="이메일">
                  <MailInput
                    type="email"
                    required
                    value={naverForm.email_address}
                    onChange={event => updateNaverField('email_address', event.target.value)}
                    placeholder={MAIL_PRESET_META[imapBrand]?.emailPlaceholder || 'name@example.com'}
                  />
                </Field>
                <Field label="표시 이름">
                  <MailInput
                    value={naverForm.display_name}
                    onChange={event => updateNaverField('display_name', event.target.value)}
                    placeholder="홍길동"
                  />
                </Field>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {(imapBrand === 'naver' || imapBrand === 'other') && (
                  <Field label="사용자 이름">
                    <MailInput
                      required
                      value={naverForm.username}
                      onChange={event => updateNaverField('username', event.target.value)}
                      placeholder={MAIL_PRESET_META[imapBrand]?.emailPlaceholder || 'name@example.com'}
                    />
                  </Field>
                )}
                <Field label="앱 비밀번호">
                  <MailInput
                    type="password"
                    required
                    value={naverForm.password}
                    onChange={event => updateNaverField('password', event.target.value)}
                    placeholder="앱 비밀번호"
                  />
                </Field>
              </div>

              {MAIL_PRESET_META[imapBrand]?.appPwUrl && (
                <a
                  href={MAIL_PRESET_META[imapBrand].appPwUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="-mt-1 inline-flex w-fit text-xs font-bold text-indigo-600 hover:underline"
                >
                  {MAIL_PRESET_META[imapBrand].appPwLabel} →
                </a>
              )}

              {hasPresetServers && (
                <button
                  type="button"
                  onClick={() => setShowAdvanced(v => !v)}
                  className="inline-flex w-fit text-xs font-bold text-gray-400 hover:text-gray-700"
                >
                  {showAdvanced ? '▾ 고급 설정(IMAP/SMTP 서버) 숨기기' : '▸ 고급 설정(IMAP/SMTP 서버)'}
                </button>
              )}

              {(!hasPresetServers || showAdvanced) && (
              <div className="grid gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="grid gap-3 sm:grid-cols-[1fr_90px_120px]">
                  <Field label="IMAP 서버">
                    <MailInput
                      required
                      value={naverForm.imap_host}
                      onChange={event => updateNaverField('imap_host', event.target.value)}
                    />
                  </Field>
                  <Field label="포트">
                    <MailInput
                      required
                      type="number"
                      min="1"
                      value={naverForm.imap_port}
                      onChange={event => updateNaverField('imap_port', event.target.value)}
                    />
                  </Field>
                  <Field label="보안">
                    <MailSelect
                      value={naverForm.imap_security}
                      onChange={event => updateNaverField('imap_security', event.target.value)}
                    >
                      <option value="ssl">SSL</option>
                      <option value="starttls">STARTTLS</option>
                      <option value="none">없음</option>
                    </MailSelect>
                  </Field>
                </div>

                <div className="grid gap-3 sm:grid-cols-[1fr_90px_120px]">
                  <Field label="SMTP 서버">
                    <MailInput
                      required
                      value={naverForm.smtp_host}
                      onChange={event => updateNaverField('smtp_host', event.target.value)}
                    />
                  </Field>
                  <Field label="포트">
                    <MailInput
                      required
                      type="number"
                      min="1"
                      value={naverForm.smtp_port}
                      onChange={event => updateNaverField('smtp_port', event.target.value)}
                    />
                  </Field>
                  <Field label="보안">
                    <MailSelect
                      value={naverForm.smtp_security}
                      onChange={event => updateNaverField('smtp_security', event.target.value)}
                    >
                      <option value="ssl">SSL</option>
                      <option value="starttls">STARTTLS</option>
                      <option value="none">없음</option>
                    </MailSelect>
                  </Field>
                </div>
              </div>
              )}

              {naverError && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-600">
                  {naverError}
                </p>
              )}

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={naverSaving}
                  className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-extrabold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-500 disabled:opacity-60"
                >
                  {naverSaving ? '저장 중...' : '저장'}
                </button>
              </div>
            </form>
          )}

          {view === 'gmail' && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-6 py-8 text-center">
              <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-white shadow-sm ring-1 ring-gray-200">
                <svg className="h-12 w-12" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
                  <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.6 8.3 6.3 14.7z" />
                  <path fill="#4CAF50" d="M24 44c5.1 0 9.8-2 13.3-5.2l-6.2-5.2C29.1 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
                  <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.4-2.3 4.3-4.2 5.6l6.2 5.2C36.9 39.1 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
                </svg>
              </div>
              <h3 className="mt-6 text-2xl font-extrabold leading-tight text-gray-900">
                웹 브라우저 인증을 완료하세요
              </h3>
              <p className="mx-auto mt-4 max-w-sm text-base leading-7 text-gray-700">
                Google 계정으로 인증하려면 웹 브라우저에 표시되는 단계를 따라주세요.
                설정이 완료되면 EasyStation으로 다시 돌아옵니다.
              </p>
              {gmailAuthError && (
                <p className="mx-auto mt-4 max-w-sm rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-600">
                  {gmailAuthError}
                </p>
              )}
              <button
                type="button"
                onClick={startGmailAuth}
                disabled={gmailAuthLoading}
                className="mt-8 rounded-lg bg-blue-600 px-12 py-3 text-base font-extrabold text-white shadow-lg shadow-blue-200 hover:bg-blue-500"
              >
                {gmailAuthLoading ? '연결 중...' : '계속'}
              </button>
            </div>
          )}

          {view === 'manage' && (
            accounts.length > 0 ? (
              <div className="grid gap-2">
                {accounts.map(account => (
                  <button
                    key={account.id}
                    type="button"
                    onClick={() => openAccountDetail(account)}
                    className="flex items-center gap-3 rounded-lg border border-gray-200 px-4 py-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50"
                  >
                    <ProviderLogo provider={account.provider} host={account.imap_host} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-extrabold text-gray-900">{getAccountLabel(account)}</span>
                      <span className="mt-0.5 block truncate text-xs text-gray-500">{account.tenant_name || account.tenant_id}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center">
                <p className="text-sm font-bold text-gray-700">삭제할 수 있는 연결 계정이 없습니다.</p>
                <p className="mt-1 text-xs text-gray-500">Gmail, 네이버, Apple 또는 기타 계정을 먼저 추가하세요.</p>
              </div>
            )
          )}

          {view === 'mailclaw' && (
            <div className="grid gap-4">
              <div className="flex items-center gap-3 rounded-lg border border-indigo-100 bg-indigo-50 px-4 py-3">
                <img src="/img/mail/mailclaw-character.png" alt="" className="h-14 w-14 flex-shrink-0 object-contain" />
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-extrabold text-gray-900">MailClaw</h3>
                  <p className="mt-0.5 text-xs leading-5 text-gray-500">켜진 조건은 AND로 판정하고, AI 분석 후 원본 전달, 폴더 이동 순서로 실행합니다.</p>
                </div>
              </div>

              <div className="flex items-end gap-3">
                <Field label="메일 공간">
                  <MailSelect
                    value={mailClawTenantId}
                    onChange={event => {
                      const tenantId = event.target.value
                      setMailClawTenantId(tenantId)
                      loadMailClawData(tenantId)
                    }}
                  >
                    {[...new Map(accounts.map(account => [account.tenant_id, account.tenant_name || account.tenant_id])).entries()].map(([id, name]) => (
                      <option key={id} value={id}>{name}</option>
                    ))}
                  </MailSelect>
                </Field>
                <button
                  type="button"
                  onClick={newMailClawRule}
                  className="h-10 rounded-lg bg-indigo-600 px-4 text-sm font-extrabold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-500"
                >
                  추가
                </button>
              </div>

              {mailClawError && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-600">{mailClawError}</p>
              )}

              <div className="grid max-h-[360px] gap-2 overflow-y-auto pr-1">
                {mailClawLoading ? (
                  <div className="rounded-lg border border-gray-200 px-4 py-6 text-center text-sm font-bold text-gray-400">불러오는 중...</div>
                ) : mailClawRules.length > 0 ? mailClawRules.map(rule => (
                  <div key={rule.id} className="rounded-lg border border-gray-200 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <button type="button" onClick={() => editMailClawRule(rule)} className="min-w-0 flex-1 text-left">
                        <span className="block truncate text-sm font-extrabold text-gray-900">{rule.name}</span>
                        <span className="mt-1 block truncate text-xs text-gray-500">
                          {[rule.sender_check_enabled ? '발신자' : '', rule.cc_check_enabled ? '참조자' : '', rule.keyword_check_enabled ? '키워드' : ''].filter(Boolean).join(' AND ') || '조건 없음'}
                          {' / '}
                          {[rule.ai_analysis_enabled ? 'AI 분석' : '', rule.forward_enabled ? '원본 전달' : '', rule.move_folder_enabled ? '폴더 이동' : '', rule.tag_smart_folder_enabled ? '스마트 폴더 태그' : ''].filter(Boolean).join(' → ') || '동작 없음'}
                        </span>
                      </button>
                      <span className={`rounded-full px-2 py-1 text-[11px] font-extrabold ${rule.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-400'}`}>
                        {rule.enabled ? 'ON' : 'OFF'}
                      </span>
                      {rule.name !== DEFAULT_MAILCLAW_TRASH_RULE_NAME && (
                        <button
                          type="button"
                          onClick={() => deleteMailClawRule(rule)}
                          disabled={mailClawSaving}
                          className="rounded-md px-2 py-1 text-xs font-bold text-red-500 hover:bg-red-50"
                        >
                          삭제
                        </button>
                      )}
                    </div>
                  </div>
                )) : (
                  <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center">
                    <p className="text-sm font-bold text-gray-700">등록된 MailClaw 규칙이 없습니다.</p>
                  </div>
                )}
              </div>

              {mailClawLogs.length > 0 && (
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <h3 className="text-sm font-extrabold text-gray-900">최근 실행 로그</h3>
                  <div className="mt-2 max-h-32 overflow-y-auto divide-y divide-gray-200">
                    {mailClawLogs.slice(0, 5).map(log => (
                      <div key={log.id} className="py-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-bold text-gray-700">{log.rule_name}</span>
                          <span className="flex-shrink-0 font-bold text-gray-400">{log.status}</span>
                        </div>
                        <div className="mt-0.5 truncate text-gray-400">{log.subject || log.from_email || log.message_id}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {view === 'mailclawEdit' && (
            <form id="mailclaw-rule-form" onSubmit={saveMailClawRule} className="grid max-h-[70vh] gap-4 overflow-y-auto pr-1">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex-shrink-0 text-xs font-bold text-gray-500">자동화 이름</span>
                  <MailInput
                    required
                    value={mailClawForm.name}
                    onChange={event => updateMailClawField('name', event.target.value)}
                    placeholder="예: 중요한 고객 메일"
                  />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2">
                  <span className="text-sm font-bold text-gray-700">활성화</span>
                  <SlideToggle
                    checked={mailClawForm.enabled}
                    onChange={value => updateMailClawField('enabled', value)}
                    label="자동화 활성화 Enable"
                  />
                </div>
              </div>

              <div className="grid gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                <h3 className="text-sm font-extrabold text-gray-900">조건</h3>
                {[
                  ['sender_check_enabled', 'sender_conditions_text', '발신자 체크', '발신자 이메일을 줄바꿈 또는 쉼표로 입력'],
                  ['cc_check_enabled', 'cc_conditions_text', '참조자 체크', '참조자 이메일을 줄바꿈 또는 쉼표로 입력'],
                  ['keyword_check_enabled', 'keyword_conditions_text', '키워드 체크', '메일 제목 키워드를 줄바꿈 또는 쉼표로 입력'],
                ].map(([enabledKey, textKey, label, placeholder]) => (
                  <div key={enabledKey} className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-3 sm:flex-row sm:items-start">
                    <div className="flex w-full flex-shrink-0 items-center justify-between gap-3 sm:w-64 sm:pt-2">
                      <span className="text-sm font-extrabold text-gray-800">{label}</span>
                      <div className="flex items-center gap-2 text-xs font-extrabold text-gray-400">
                        <span>Enable</span>
                        <SlideToggle
                          checked={!!mailClawForm[enabledKey]}
                          onChange={value => updateMailClawField(enabledKey, value)}
                          label={`${label} Enable`}
                        />
                      </div>
                    </div>
                    <textarea
                      value={mailClawForm[textKey]}
                      onChange={event => updateMailClawField(textKey, event.target.value)}
                      disabled={!mailClawForm[enabledKey]}
                      placeholder={placeholder}
                      className="min-h-[70px] w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 disabled:bg-gray-100 disabled:text-gray-400"
                    />
                  </div>
                ))}
              </div>

              <div className="grid gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                <h3 className="text-sm font-extrabold text-gray-900">동작</h3>
                <div className="grid gap-3 rounded-lg border border-gray-200 bg-white p-3 sm:grid-cols-[280px_96px_minmax(0,1fr)] sm:items-center">
                  <span className="whitespace-nowrap text-sm font-bold text-gray-700">AI 메일 분석</span>
                  <div className="flex items-center gap-2 text-xs font-extrabold text-gray-400 sm:justify-end">
                    <span>Enable</span>
                    <SlideToggle
                      checked={mailClawForm.ai_analysis_enabled}
                      onChange={value => updateMailClawField('ai_analysis_enabled', value)}
                      label="AI 메일 분석 Enable"
                    />
                  </div>
                  <div className="hidden sm:block" />
                </div>
                <div className="grid gap-3 rounded-lg border border-gray-200 bg-white p-3 sm:grid-cols-[280px_96px_minmax(0,1fr)] sm:items-center">
                  <span className="whitespace-nowrap text-sm font-bold text-gray-700">지정된 메일 주소로 원본 메일 전달</span>
                  <div className="flex items-center gap-2 text-xs font-extrabold text-gray-400 sm:justify-end">
                    <span>Enable</span>
                    <SlideToggle
                      checked={mailClawForm.forward_enabled}
                      onChange={value => updateMailClawField('forward_enabled', value)}
                      label="지정된 메일 주소로 원본 메일 전달 Enable"
                    />
                  </div>
                  <textarea
                    value={mailClawForm.forward_addresses_text}
                    onChange={event => updateMailClawField('forward_addresses_text', event.target.value)}
                    disabled={!mailClawForm.forward_enabled}
                    placeholder="전달 받을 메일 주소"
                    className="min-h-10 w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 disabled:bg-gray-100 disabled:text-gray-400"
                  />
                </div>
                <div className="grid gap-3 rounded-lg border border-gray-200 bg-white p-3 sm:grid-cols-[280px_96px_minmax(0,1fr)] sm:items-center">
                  <span className="whitespace-nowrap text-sm font-bold text-gray-700">지정된 폴더로 이동</span>
                  <div className="flex items-center gap-2 text-xs font-extrabold text-gray-400 sm:justify-end">
                    <span>Enable</span>
                    <SlideToggle
                      checked={mailClawForm.move_folder_enabled}
                      onChange={value => updateMailClawField('move_folder_enabled', value)}
                      label="지정된 폴더로 이동 Enable"
                    />
                  </div>
                  <select
                    value={mailClawForm.target_folder_id}
                    onChange={event => updateMailClawField('target_folder_id', event.target.value)}
                    disabled={!mailClawForm.move_folder_enabled}
                    className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-700 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    <option value="">폴더 선택</option>
                    {mailClawFolders.map(folder => (
                      <option key={folder.id} value={folder.id}>{folder.label}</option>
                    ))}
                  </select>
                </div>

                {/* 스마트 폴더 태그 부여(+아카이브) — MailService.md 13.6 */}
                <div className="grid gap-3 rounded-lg border border-gray-200 bg-white p-3 sm:grid-cols-[280px_96px_minmax(0,1fr)] sm:items-center">
                  <span className="whitespace-nowrap text-sm font-bold text-gray-700">스마트 폴더에 태그</span>
                  <div className="flex items-center gap-2 text-xs font-extrabold text-gray-400 sm:justify-end">
                    <span>Enable</span>
                    <SlideToggle
                      checked={mailClawForm.tag_smart_folder_enabled}
                      onChange={value => updateMailClawField('tag_smart_folder_enabled', value)}
                      label="스마트 폴더에 태그 Enable"
                    />
                  </div>
                  <select
                    value={mailClawForm.tag_smart_folder_id}
                    onChange={event => updateMailClawField('tag_smart_folder_id', event.target.value)}
                    disabled={!mailClawForm.tag_smart_folder_enabled}
                    className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-700 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    <option value="">스마트 폴더 선택</option>
                    {mailClawSmartFolders.map(folder => (
                      <option key={folder.id} value={folder.id}>{folder.name}</option>
                    ))}
                  </select>
                  {mailClawForm.tag_smart_folder_enabled && (
                    <label className="flex items-center gap-2 text-xs font-bold text-gray-500 sm:col-span-3">
                      <input
                        type="checkbox"
                        checked={mailClawForm.tag_archive_enabled}
                        onChange={event => updateMailClawField('tag_archive_enabled', event.target.checked)}
                        className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span>태그와 함께 각 계정의 보관함으로 이동(받은편지함에서 치움 · 하드 삭제 아님)</span>
                    </label>
                  )}
                  {mailClawSmartFolders.length === 0 && (
                    <p className="text-[11px] font-semibold text-gray-400 sm:col-span-3">아직 스마트 폴더가 없습니다. 메일 사이드바에서 먼저 스마트 폴더를 만들어주세요.</p>
                  )}
                </div>
              </div>

              {mailClawError && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-600">{mailClawError}</p>
              )}

              {mailClawApplyProgress && (
                <div className="rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-3">
                  <div className="flex items-center justify-between gap-3 text-xs font-extrabold text-indigo-900">
                    <span>{mailClawApplyProgress.current}</span>
                    <span>
                      {mailClawApplyProgress.total
                        ? `${Math.round((mailClawApplyProgress.done / mailClawApplyProgress.total) * 100)}%`
                        : mailClawApplyProgress.phase === 'collecting' ? '준비 중' : '0%'}
                    </span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-white">
                    <div
                      className={`h-full rounded-full bg-indigo-600 transition-all ${mailClawApplyProgress.phase === 'collecting' ? 'animate-pulse' : ''}`}
                      style={{
                        width: mailClawApplyProgress.total
                          ? `${Math.max(4, Math.round((mailClawApplyProgress.done / mailClawApplyProgress.total) * 100))}%`
                          : mailClawApplyProgress.phase === 'collecting' ? '35%' : '0%',
                      }}
                    />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-bold text-indigo-700">
                    <span>총 {mailClawApplyProgress.total}</span>
                    <span>완료 {mailClawApplyProgress.done}</span>
                    <span>일치 {mailClawApplyProgress.matched}</span>
                    <span>건너뜀 {mailClawApplyProgress.skipped}</span>
                    <span>실패 {mailClawApplyProgress.failed}</span>
                  </div>
                </div>
              )}

            </form>
          )}

          {view === 'accountDetail' && selectedAccount && (
            <div className="grid gap-4">
              <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                <ProviderLogo provider={selectedAccount.provider} host={selectedAccount.imap_host} />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-extrabold text-gray-900">
                    {accountEditMode ? '메일 계정 편집' : '메일 계정 관리'}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-gray-500">{selectedAccount.email_address}</span>
                </div>
                {isImapAccount(selectedAccount) && !accountEditMode && (
                  <button
                    type="button"
                    onClick={() => {
                      setAccountEditForm(accountToEditForm(selectedAccount))
                      setAccountEditMode(true)
                      setAccountError('')
                    }}
                    className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-extrabold text-white hover:bg-indigo-500"
                  >
                    편집
                  </button>
                )}
              </div>

              {isImapAccount(selectedAccount) && accountEditMode && accountEditForm ? (
                <form onSubmit={saveAccountEdit} className="grid gap-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="이메일">
                      <MailInput
                        type="email"
                        required
                        value={accountEditForm.email_address}
                        onChange={event => updateAccountEditField('email_address', event.target.value)}
                      />
                    </Field>
                    <Field label="표시 이름">
                      <MailInput
                        value={accountEditForm.display_name}
                        onChange={event => updateAccountEditField('display_name', event.target.value)}
                      />
                    </Field>
                    <Field label="사용자 이름">
                      <MailInput
                        required
                        value={accountEditForm.username}
                        onChange={event => updateAccountEditField('username', event.target.value)}
                      />
                    </Field>
                  </div>

                  <div className="grid gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                    <h3 className="text-sm font-extrabold text-gray-900">IMAP/SMTP 설정</h3>
                    <div className="grid gap-3 sm:grid-cols-[1fr_90px_120px]">
                      <Field label="IMAP 서버">
                        <MailInput
                          required
                          value={accountEditForm.imap_host}
                          onChange={event => updateAccountEditField('imap_host', event.target.value)}
                        />
                      </Field>
                      <Field label="포트">
                        <MailInput
                          required
                          type="number"
                          min="1"
                          value={accountEditForm.imap_port}
                          onChange={event => updateAccountEditField('imap_port', event.target.value)}
                        />
                      </Field>
                      <Field label="보안">
                        <MailSelect
                          value={accountEditForm.imap_security}
                          onChange={event => updateAccountEditField('imap_security', event.target.value)}
                        >
                          <option value="ssl">SSL</option>
                          <option value="starttls">STARTTLS</option>
                          <option value="none">없음</option>
                        </MailSelect>
                      </Field>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-[1fr_90px_120px]">
                      <Field label="SMTP 서버">
                        <MailInput
                          required
                          value={accountEditForm.smtp_host}
                          onChange={event => updateAccountEditField('smtp_host', event.target.value)}
                        />
                      </Field>
                      <Field label="포트">
                        <MailInput
                          required
                          type="number"
                          min="1"
                          value={accountEditForm.smtp_port}
                          onChange={event => updateAccountEditField('smtp_port', event.target.value)}
                        />
                      </Field>
                      <Field label="보안">
                        <MailSelect
                          value={accountEditForm.smtp_security}
                          onChange={event => updateAccountEditField('smtp_security', event.target.value)}
                        >
                          <option value="ssl">SSL</option>
                          <option value="starttls">STARTTLS</option>
                          <option value="none">없음</option>
                        </MailSelect>
                      </Field>
                    </div>

                    <Field label="새 앱 비밀번호">
                      <MailInput
                        type="password"
                        value={accountEditForm.password}
                        onChange={event => updateAccountEditField('password', event.target.value)}
                        placeholder="변경할 때만 입력"
                      />
                    </Field>
                  </div>

                  {accountError && (
                    <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-600">
                      {accountError}
                    </p>
                  )}

                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setAccountEditMode(false)
                        setAccountEditForm(accountToEditForm(selectedAccount))
                        setAccountError('')
                      }}
                      className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-bold text-gray-600 hover:bg-gray-50"
                    >
                      취소
                    </button>
                    <button
                      type="submit"
                      disabled={accountSaving}
                      className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-extrabold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-500 disabled:opacity-60"
                    >
                      {accountSaving ? '저장 중...' : '저장'}
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <DetailValue label="이메일" value={selectedAccount.email_address} />
                    <DetailValue label="표시 이름" value={selectedAccount.display_name} />
                    <DetailValue label="사용자 이름" value={selectedAccount.username || selectedAccount.email_address} />
                  </div>

                  {isImapAccount(selectedAccount) && (
                    <div className="grid gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                      <h3 className="text-sm font-extrabold text-gray-900">IMAP/SMTP 설정</h3>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <DetailValue label="IMAP 서버" value={selectedAccount.imap_host} />
                        <DetailValue label="IMAP 포트" value={selectedAccount.imap_port} />
                        <DetailValue label="IMAP 보안" value={formatSecurity(selectedAccount.imap_security)} />
                        <DetailValue label="SMTP 서버" value={selectedAccount.smtp_host} />
                        <DetailValue label="SMTP 포트" value={selectedAccount.smtp_port} />
                        <DetailValue label="SMTP 보안" value={formatSecurity(selectedAccount.smtp_security)} />
                      </div>
                      <DetailValue label="암호" value="저장됨" />
                    </div>
                  )}
                </>
              )}

              {!isImapAccount(selectedAccount) && (
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-6 text-center">
                  <p className="text-sm font-bold text-gray-700">이 계정의 상세 설정 화면은 준비 중입니다.</p>
                </div>
              )}

              {!accountEditMode && (
                <div className="flex items-center justify-between border-t border-gray-100 pt-4">
                  <span className="text-xs text-gray-400">연동을 해제하면 이 계정의 동기화 데이터가 모두 삭제됩니다.</span>
                  <button
                    type="button"
                    onClick={deleteAccount}
                    disabled={accountSaving}
                    className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-extrabold text-red-600 hover:bg-red-100 disabled:opacity-60"
                  >
                    {accountSaving ? '처리 중...' : '연동 해제(삭제)'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-gray-200 bg-gray-50 px-6 py-4">
          {view === 'main' ? (
            <span className="text-xs text-gray-400">4.0.1 메일 계정 관리 메뉴</span>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (view === 'accountDetail') {
                  setSelectedAccount(null)
                  setView('manage')
                } else if (view === 'mailclawEdit') {
                  setView('mailclaw')
                } else {
                  setView(view === 'gmail' || view === 'imap' ? 'add' : 'main')
                }
              }}
              className="text-sm font-bold text-gray-500 hover:text-gray-900"
            >
              뒤로
            </button>
          )}
          <div className="flex items-center gap-2">
            {view === 'mailclawEdit' && (
              <>
                <button
                  type="button"
                  onClick={() => setView('mailclaw')}
                  className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-bold text-gray-600 hover:bg-gray-50"
                >
                  취소
                </button>
                <button
                  type="button"
                  onClick={applySelectedMailClawToCurrentFolder}
                  disabled={!hasMailClawActiveScope || !mailClawActiveTenantId || mailClawTenantId !== mailClawActiveTenantId || mailClawApplying || mailClawSaving}
                  title={
                    !hasMailClawActiveScope
                      ? '현재 선택된 폴더가 없습니다'
                      : mailClawTenantId !== mailClawActiveTenantId
                        ? '선택된 MailClaw와 현재 폴더의 메일 공간이 다릅니다'
                        : `${mailClawActiveScopeLabel}에 적용`
                  }
                  className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-extrabold text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {mailClawApplying ? '적용 중...' : '현재 폴더에 적용'}
                </button>
                <button
                  type="submit"
                  form="mailclaw-rule-form"
                  disabled={mailClawSaving || mailClawApplying}
                  className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-extrabold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-500 disabled:opacity-60"
                >
                  {mailClawSaving ? '저장 중...' : '저장'}
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-bold text-white shadow-lg shadow-indigo-200 hover:bg-indigo-500"
            >
              닫기
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function MailInputDialog({
  title,
  message,
  initialValue = '',
  confirmText = '확인',
  cancelText = '취소',
  loading = false,
  onConfirm,
  onCancel,
}) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef(null)
  const onCancelRef = useRef(onCancel)

  useEffect(() => {
    onCancelRef.current = onCancel
  }, [onCancel])

  useEffect(() => {
    window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
  }, [])

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'Escape' && !loading) onCancelRef.current?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [loading])

  const cleanValue = value.trim()

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 px-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl">
        <h3 className="text-base font-extrabold text-gray-950">{title}</h3>
        {message ? (
          <p className="mt-3 text-sm font-semibold leading-6 text-gray-600">{message}</p>
        ) : null}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && cleanValue && !loading) onConfirm?.(cleanValue)
          }}
          disabled={loading}
          className="mt-4 h-11 w-full rounded-lg border border-indigo-200 px-3 text-sm font-bold text-gray-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-gray-50 disabled:text-gray-400"
        />
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="rounded-xl px-4 py-2 text-sm font-bold text-gray-500 transition hover:bg-gray-100 disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={() => cleanValue && onConfirm?.(cleanValue)}
            disabled={loading || !cleanValue}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? '처리 중...' : confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function MailPage({ onBackToMain, initialMailLink = null, onOpenCalendarEvent }) {
  const { showToast } = useToast()
  const { language } = useAuth()
  const mt = getMailText(language)
  const [tenants, setTenants] = useState([])
  const [accounts, setAccounts] = useState([])
  const [mailMetaLoading, setMailMetaLoading] = useState(false)
  const [mailMetaError, setMailMetaError] = useState('')
  const [activeKey, setActiveKey] = useState(`${UNIFIED_KEY_PREFIX}all`)
  const [unifiedFolderColors, setUnifiedFolderColors] = useState(() => {
    try {
      if (typeof window === 'undefined') return {}
      const rows = JSON.parse(window.localStorage.getItem(UNIFIED_FOLDER_COLOR_STORAGE_KEY) || '{}')
      return rows && typeof rows === 'object' && !Array.isArray(rows) ? rows : {}
    } catch {
      return {}
    }
  })
  const [mailSearchQuery, setMailSearchQuery] = useState('')
  // 통합 스마트 폴더(태그 기반 — MailService.md 13). [{ id, name, color_key, message_count, unread_count }]
  const [smartFolders, setSmartFolders] = useState([])
  // 스마트 폴더 구역 접기/펴기(헤더 클릭 토글). 브라우저에 유지.
  const [smartSectionCollapsed, setSmartSectionCollapsed] = useState(() => {
    try { return typeof window !== 'undefined' && window.localStorage.getItem('mail-smart-section-collapsed') === '1' } catch { return false }
  })
  const [collapsedAccountIds, setCollapsedAccountIds] = useState(() => new Set())
  const [showAccountModal, setShowAccountModal] = useState(false)
  const [messages, setMessages] = useState([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messagesError, setMessagesError] = useState('')
  const [hasMoreMessages, setHasMoreMessages] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshLoading, setRefreshLoading] = useState(false)
  const [composeMode, setComposeMode] = useState(false)
  const [composeDraft, setComposeDraft] = useState(null)
  const [selectedMessage, setSelectedMessage] = useState(null)
  const [selectedMessageIds, setSelectedMessageIds] = useState([])
  const [lastSelectedMessageId, setLastSelectedMessageId] = useState(null)
  // Drag & Drop: 드롭 하이라이트 대상 폴더 키(계정:폴더). (MailService.md 11)
  const [dropTargetKey, setDropTargetKey] = useState(null)
  const [messageMenu, setMessageMenu] = useState(null)
  const [folderMenu, setFolderMenu] = useState(null)
  const [unifiedFolderMenu, setUnifiedFolderMenu] = useState(null)
  const [smartFolderMenu, setSmartFolderMenu] = useState(null)
  const [mailClawRegistration, setMailClawRegistration] = useState(null)
  const [pendingEmptyTrash, setPendingEmptyTrash] = useState(null)
  // 폴더 삭제 확인 대기: { account, folder, message, danger }
  const [pendingDeleteFolder, setPendingDeleteFolder] = useState(null)
  const [folderNameDialog, setFolderNameDialog] = useState(null)
  const [folderNameDialogLoading, setFolderNameDialogLoading] = useState(false)
  // 통합 휴지통 비우기(여러 계정 한 번에) 확인 대기. (MailService.md 15)
  const [pendingEmptyUnifiedTrash, setPendingEmptyUnifiedTrash] = useState(null)
  const [messageDetailLoading, setMessageDetailLoading] = useState(false)
  const [messageDetailError, setMessageDetailError] = useState('')
  const folderSyncTimesRef = useRef(new Map())
  const handledInitialMailLinkRef = useRef('')
  const preserveSelectionOnNextLoadRef = useRef(null)
  const messageLoadSeqRef = useRef(0)
  const loadMoreSeqRef = useRef(0)

  const displayedMessages = useMemo(() => {
    const query = mailSearchQuery.trim().toLowerCase()
    if (!query) return messages
    return messages.filter(message => {
      const haystack = [
        message.subject,
        message.snippet,
        message.from_name,
        message.from_email,
        addressListToSearchText(message.to_json),
        addressListToSearchText(message.cc_json),
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(query)
    })
  }, [mailSearchQuery, messages])

  const currentTenantId = accounts.find(account => account.tenant_id)?.tenant_id
    || tenants.find(item => item.type === 'personal')?.id
    || tenants[0]?.id
    || ''
  const activeKeyRef = useRef(activeKey)
  const currentTenantIdRef = useRef(currentTenantId)
  const messagesLengthRef = useRef(messages.length)
  useEffect(() => {
    activeKeyRef.current = activeKey
    currentTenantIdRef.current = currentTenantId
    messagesLengthRef.current = messages.length
  }, [activeKey, currentTenantId, messages.length])
  // 통합 사이드바 ① 시스템 항목만 남긴다. 이름-집계 커스텀 폴더는 13장 스마트 폴더로 대치(제거). (MailService.md 13.2.1)
  const unifiedMenus = useMemo(() => {
    const totalsByType = new Map()
    const allTotals = { message_count: 0, unread_count: 0 }
    // 별표됨은 폴더 타입이 아니라 교차 플래그(is_starred)이므로 모든 폴더의 별표 수를 합산한다.
    // (별표됨 목록은 휴지통을 제외하지 않으므로 여기서도 제외하지 않는다. MailService.md 13)
    const starredTotals = { message_count: 0, unread_count: 0 }

    for (const account of accounts) {
      if (currentTenantId && account.tenant_id !== currentTenantId) continue
      for (const folder of account.folders || []) {
        const messageCount = Number(folder.message_count || 0)
        const unreadCount = Number(folder.unread_count || 0)
        if (!isMailTrashFolder(folder)) {
          allTotals.message_count += messageCount
          allTotals.unread_count += unreadCount
        }

        starredTotals.message_count += Number(folder.starred_count || 0)
        starredTotals.unread_count += Number(folder.starred_unread_count || 0)

        const type = String(folder.type || '').trim()
        if (type) {
          const prev = totalsByType.get(type) || { message_count: 0, unread_count: 0 }
          prev.message_count += messageCount
          prev.unread_count += unreadCount
          totalsByType.set(type, prev)
        }
      }
    }

    const systemMenus = UNIFIED_SYSTEM_FOLDERS.map(item => {
      const counts = item.key === 'all'
        ? allTotals
        : item.key === 'starred'
          ? starredTotals
          : item.type
            ? (totalsByType.get(item.type) || { message_count: 0, unread_count: 0 })
            : { message_count: 0, unread_count: 0 }
      return { ...item, ...counts }
    })

    return systemMenus.map(item => ({
      ...item,
      label: mt.folders[item.labelKey] || item.key,
      color_key: unifiedFolderColors[`${currentTenantId}:${item.key}`] || '',
    }))
  }, [accounts, currentTenantId, unifiedFolderColors, mt])

  // lg(≥1024px) 이상에서만 목록↔본문을 드래그로 리사이즈한다. 그 미만은 기존 세로 스택 유지.
  const [isDesktopSplit, setIsDesktopSplit] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const handler = (event) => setIsDesktopSplit(event.matches)
    setIsDesktopSplit(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // md(≥768px) 이상에서 사이드바↔본문 사이를 드래그로 리사이즈한다. 그 미만은 기존 세로 스택 유지.
  const [isSidebarResizable, setIsSidebarResizable] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const handler = (event) => setIsSidebarResizable(event.matches)
    setIsSidebarResizable(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === 'undefined') return 256
    const saved = Number(window.localStorage.getItem('mail-sidebar-width'))
    return saved >= 200 && saved <= 480 ? saved : 256
  })
  function startSidebarResize(event) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth
    let lastWidth = startWidth
    const onMove = (moveEvent) => {
      lastWidth = Math.min(480, Math.max(200, startWidth + (moveEvent.clientX - startX)))
      setSidebarWidth(lastWidth)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try { window.localStorage.setItem('mail-sidebar-width', String(Math.round(lastWidth))) } catch { /* noop */ }
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  useEffect(() => {
    let cancelled = false
    setMailMetaLoading(true)
    setMailMetaError('')
    Promise.all([
      apiFetch('/mail/tenants'),
      apiFetch('/mail/accounts'),
    ])
      .then(([tenantRows, accountRows]) => {
        if (cancelled) return
        setTenants(Array.isArray(tenantRows) ? tenantRows : [])
        setAccounts(Array.isArray(accountRows) ? accountRows : [])
      })
      .catch(err => {
        if (cancelled) return
        setMailMetaError(err.message || '메일 구조 정보를 불러오지 못했습니다.')
      })
      .finally(() => {
        if (!cancelled) setMailMetaLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  async function reloadMailAccounts() {
    const accountRows = await apiFetch('/mail/accounts')
    setAccounts(Array.isArray(accountRows) ? accountRows : [])
    return Array.isArray(accountRows) ? accountRows : []
  }

  async function reloadSmartFolders(tenantId = currentTenantId) {
    if (!tenantId) return []
    const rows = await apiFetch(`/mail/smart-folders?tenantId=${encodeURIComponent(tenantId)}`)
    const list = Array.isArray(rows) ? rows : []
    setSmartFolders(list)
    return list
  }

  // 스마트 폴더 로드 + 최초 1회 시드 마이그레이션(이름-집계 폴더 → 동명 스마트 폴더). tenant별 멱등.
  useEffect(() => {
    if (!currentTenantId) return
    let cancelled = false
    ;(async () => {
      try {
        const seededKey = `${SMART_SEED_STORAGE_KEY}:${currentTenantId}`
        const alreadySeeded = typeof window !== 'undefined' && window.localStorage.getItem(seededKey) === '1'
        if (!alreadySeeded) {
          try {
            await apiFetch('/mail/smart-folders/seed', { method: 'POST', body: JSON.stringify({ tenantId: currentTenantId }) })
            if (typeof window !== 'undefined') window.localStorage.setItem(seededKey, '1')
          } catch { /* 시드 실패는 무시(다음 로드 때 재시도) */ }
        }
        // 이중 휴지통 정리(멱등). 재동기화 전에 1회 실행해 중복을 막는다. (MailService.md 17)
        const reconciledKey = `mail-trash-reconciled-v1:${currentTenantId}`
        const alreadyReconciled = typeof window !== 'undefined' && window.localStorage.getItem(reconciledKey) === '1'
        if (!alreadyReconciled) {
          try {
            await apiFetch('/mail/reconcile-trash', { method: 'POST', body: JSON.stringify({ tenantId: currentTenantId }) })
            if (typeof window !== 'undefined') window.localStorage.setItem(reconciledKey, '1')
          } catch { /* 정리 실패는 무시(다음 로드 때 재시도) */ }
        }
        const rows = await apiFetch(`/mail/smart-folders?tenantId=${encodeURIComponent(currentTenantId)}`)
        if (!cancelled) setSmartFolders(Array.isArray(rows) ? rows : [])
      } catch { /* noop */ }
    })()
    return () => { cancelled = true }
  }, [currentTenantId])

  function openAgenticPanel() {
    window.dispatchEvent(new CustomEvent('open-agentic-panel'))
  }

  function openCompose() {
    setComposeDraft(null)
    setComposeMode(true)
    setSelectedMessage(null)
    setSelectedMessageIds([])
    setLastSelectedMessageId(null)
    setMessageMenu(null)
    setMessageDetailError('')
  }

  function updateActiveKey(key) {
    activeKeyRef.current = key
    setLastSelectedMessageId(null)
    setActiveKey(key)
  }

  function activateMailKey(key) {
    setComposeDraft(null)
    setComposeMode(false)
    updateActiveKey(key)
  }

  function toggleAccount(accountId) {
    setCollapsedAccountIds(prev => {
      const next = new Set(prev)
      if (next.has(accountId)) next.delete(accountId)
      else next.add(accountId)
      return next
    })
  }

  function resolveActiveFolder(sourceAccounts = accounts) {
    if (!activeKey.includes(':')) return null
    if (activeKey.startsWith(UNIFIED_KEY_PREFIX)) return null
    if (activeKey.startsWith(SMART_KEY_PREFIX)) return null
    const [accountId, folderKey] = activeKey.split(':')
    const account = sourceAccounts.find(item => item.id === accountId)
    const folder = (account?.folders || []).find(item => String(item.id || item.name) === folderKey)
    if (!account || !folder) return null
    return { account, folder }
  }

  function resolveActiveUnified(sourceMenus = unifiedMenus) {
    if (!activeKey.startsWith(UNIFIED_KEY_PREFIX)) return null
    const key = activeKey.slice(UNIFIED_KEY_PREFIX.length)
    return sourceMenus.find(item => item.key === key) || null
  }

  // 활성 스마트 폴더(태그 기반 통합 — MailService.md 13). activeKey = 'smart:<id>'
  function resolveActiveSmart(sourceFolders = smartFolders) {
    if (!activeKey.startsWith(SMART_KEY_PREFIX)) return null
    const id = activeKey.slice(SMART_KEY_PREFIX.length)
    return sourceFolders.find(item => item.id === id) || null
  }

  function buildMessageViewKey(key = activeKey, tenantId = currentTenantId) {
    const safeTenantId = String(tenantId || '').trim()
    const safeKey = String(key || '').trim()
    if (!safeKey) return ''
    if (safeKey.startsWith(SMART_KEY_PREFIX)) {
      const smartFolderId = safeKey.slice(SMART_KEY_PREFIX.length)
      return smartFolderId && safeTenantId ? `smart:${safeTenantId}:${smartFolderId}` : ''
    }
    if (safeKey.startsWith(UNIFIED_KEY_PREFIX)) {
      const unifiedKey = safeKey.slice(UNIFIED_KEY_PREFIX.length)
      return unifiedKey && safeTenantId ? `unified:${safeTenantId}:${unifiedKey}` : ''
    }
    return safeTenantId ? `folder:${safeTenantId}:${safeKey}` : ''
  }

  function buildActiveMessageRequest(sourceAccounts = accounts) {
    const tenantId = currentTenantId || sourceAccounts[0]?.tenant_id || ''

    if (activeKey.startsWith(SMART_KEY_PREFIX)) {
      const smartFolderId = activeKey.slice(SMART_KEY_PREFIX.length)
      if (!tenantId || !smartFolderId) return null
      return {
        kind: 'smart',
        tenantId,
        viewKey: buildMessageViewKey(activeKey, tenantId),
        params: new URLSearchParams({
          tenantId,
          scope: 'smart',
          smartFolderId,
          limit: String(MAIL_PAGE_SIZE),
          offset: '0',
        }),
      }
    }

    const active = resolveActiveFolder(sourceAccounts)
    if (active) {
      return {
        kind: 'folder',
        tenantId: active.account.tenant_id,
        viewKey: buildMessageViewKey(activeKey, active.account.tenant_id),
        params: new URLSearchParams({
          tenantId: active.account.tenant_id,
          accountId: active.account.id,
          folderId: active.folder.id,
          limit: String(MAIL_PAGE_SIZE),
          offset: '0',
        }),
      }
    }

    const unified = resolveActiveUnified()
    if (unified && tenantId) {
      return {
        kind: 'unified',
        tenantId,
        viewKey: buildMessageViewKey(activeKey, tenantId),
        params: new URLSearchParams({
          tenantId,
          scope: 'unified',
          unifiedKey: unified.key,
          folderType: unified.type || '',
          folderName: unified.folderName || '',
          limit: String(MAIL_PAGE_SIZE),
          offset: '0',
        }),
      }
    }

    return null
  }

  function markMessageReadInState(message) {
    if (!message?.id || message.is_read) return
    setMessages(prev => prev.map(item => (
      item.id === message.id ? { ...item, is_read: true } : item
    )))
    setAccounts(prev => prev.map(account => {
      if (account.id !== message.account_id) return account
      return {
        ...account,
        folders: (account.folders || []).map(folder => {
          if (folder.id !== message.folder_id) return folder
          return {
            ...folder,
            unread_count: Math.max(0, Number(folder.unread_count || 0) - 1),
          }
        }),
      }
    }))
  }

  function adjustFolderCounts({ accountId, folderId, totalDelta = 0, unreadDelta = 0, starredDelta = 0, starredUnreadDelta = 0 }) {
    if (!accountId || !folderId) return
    setAccounts(prev => prev.map(account => {
      if (account.id !== accountId) return account
      return {
        ...account,
        folders: (account.folders || []).map(folder => {
          if (folder.id !== folderId) return folder
          return {
            ...folder,
            message_count: Math.max(0, Number(folder.message_count || 0) + totalDelta),
            unread_count: Math.max(0, Number(folder.unread_count || 0) + unreadDelta),
            starred_count: Math.max(0, Number(folder.starred_count || 0) + starredDelta),
            starred_unread_count: Math.max(0, Number(folder.starred_unread_count || 0) + starredUnreadDelta),
          }
        }),
      }
    }))
  }

  function restoreMessagesBySnapshot(currentList, snapshotList, restoreIds) {
    if (!restoreIds?.size) return currentList
    const currentById = new Map(currentList.map(item => [String(item.id), item]))
    const snapshotIds = new Set(snapshotList.map(item => String(item.id)))
    const restored = []
    for (const item of snapshotList) {
      const id = String(item.id)
      if (restoreIds.has(id)) {
        restored.push(item)
      } else if (currentById.has(id)) {
        restored.push(currentById.get(id))
      }
    }
    for (const item of currentList) {
      if (!snapshotIds.has(String(item.id))) restored.push(item)
    }
    return restored
  }

  function getActionMessages(target) {
    const ids = Array.isArray(target?.targetIds) && target.targetIds.length
      ? new Set(target.targetIds)
      : new Set(target?.id ? [target.id] : target?.message?.id ? [target.message.id] : [])
    return messages.filter(item => ids.has(item.id))
  }

  function openMessageMenu(event, message, index) {
    event.preventDefault()
    event.stopPropagation()
    const isAlreadySelected = selectedMessageIds.includes(message.id)
    const targetIds = isAlreadySelected && selectedMessageIds.length > 0
      ? selectedMessageIds
      : [message.id]
    if (!isAlreadySelected) {
      setSelectedMessageIds([message.id])
      setLastSelectedMessageId(message.id)
    }
    // 원좌표만 저장하고, 실제 위치 보정은 useAnchoredMenuPosition이 렌더 후 실측으로 처리한다. (MailService.md 19.55)
    setMessageMenu({
      x: event.clientX,
      y: event.clientY,
      message,
      targetIds,
    })
  }

  function registerMailClawFromMessage(menu) {
    const message = menu?.message
    const senderEmail = String(message?.from_email || '').trim()
    if (!senderEmail) {
      setMessagesError('보낸 사람의 메일 주소를 확인할 수 없습니다.')
      return
    }
    const account = accounts.find(item => item.id === message.account_id)
    const tenantId = account?.tenant_id || message.tenant_id || currentTenantId || ''
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(senderEmail).catch(() => {})
    }
    setMailClawRegistration({
      id: `${message.id || senderEmail}:${Date.now()}`,
      senderEmail,
      tenantId,
    })
    setShowAccountModal(true)
  }

  async function registerMailClawTrashFromMessage(menu) {
    const message = menu?.message
    const senderEmail = String(message?.from_email || '').trim()
    if (!senderEmail) {
      setMessagesError('보낸 사람의 메일 주소를 확인할 수 없습니다.')
      return
    }
    const account = accounts.find(item => item.id === message.account_id)
    const tenantId = account?.tenant_id || message.tenant_id || currentTenantId || ''
    if (!tenantId) {
      setMessagesError('MailClaw를 등록할 메일 공간을 확인할 수 없습니다.')
      return
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(senderEmail).catch(() => {})
    }
    try {
      const rule = await apiFetch('/mail/mailclaw/trash-rule/register-sender', {
        method: 'POST',
        body: JSON.stringify({ tenantId, senderEmail }),
      })
      setMessagesError('')
      const count = Array.isArray(rule?.sender_conditions) ? rule.sender_conditions.length : 0
      showToast({
        message: `'${senderEmail}' 을(를) MailClaw 휴지통 이동 발신자 목록에 추가했습니다.${count ? ` (총 ${count}개)` : ''}`,
        tone: 'success',
      })
    } catch (err) {
      setMessagesError(err.message || 'MailClaw 휴지통 이동 규칙에 등록하지 못했습니다.')
    }
  }

  function openFolderMenu(event, account, folder) {
    event.preventDefault()
    event.stopPropagation()
    setFolderMenu({
      x: event.clientX,
      y: event.clientY,
      account,
      folder,
    })
  }

  function openUnifiedFolderMenu(event, folder) {
    event.preventDefault()
    event.stopPropagation()
    setUnifiedFolderMenu({
      x: event.clientX,
      y: event.clientY,
      folder,
    })
  }

  function clearMailSelection() {
    setSelectedMessage(null)
    setSelectedMessageIds([])
    setLastSelectedMessageId(null)
    setMessageDetailError('')
    setMessageMenu(null)
  }

	  async function emptyTrashFolder(menu) {
    const account = menu?.account
    const folder = menu?.folder
    if (!account?.id || !folder?.id) return

    try {
      const params = new URLSearchParams({ tenantId: account.tenant_id })
      const result = await apiFetch(`/mail/accounts/${account.id}/folders/${folder.id}/trash?${params.toString()}`, {
        method: 'DELETE',
      })
      const purgedUnread = Number(result?.unread_count || folder.unread_count || 0)
      const purgedCount = Number(result?.count || folder.message_count || 0)
      setAccounts(prev => prev.map(item => {
        if (item.id !== account.id) return item
        return {
          ...item,
          folders: (item.folders || []).map(folderItem => (
            folderItem.id === folder.id
              ? { ...folderItem, message_count: 0, unread_count: 0 }
              : folderItem
          )),
        }
      }))
      const active = resolveActiveFolder()
      if (active?.folder?.id === folder.id) {
        setMessages([])
        clearMailSelection()
        setHasMoreMessages(false)
      }
      if (purgedCount > 0 || purgedUnread > 0) {
        setMessagesError('')
      }
    } catch (err) {
      setMessagesError(err.message || '휴지통을 비우지 못했습니다.')
    } finally {
      setPendingEmptyTrash(null)
    }
	  }

  // 통합 휴지통 비우기: 현재 tenant의 모든 계정 휴지통 폴더를 각각 비운다(계정별 기존 라우트 재사용). (MailService.md 15)
  function getUnifiedTrashTargets() {
    const targets = []
    for (const account of accounts) {
      if (currentTenantId && account.tenant_id !== currentTenantId) continue
      for (const folder of account.folders || []) {
        if (isMailTrashFolder(folder) && folder.id) targets.push({ account, folder })
      }
    }
    return targets
  }

  async function emptyUnifiedTrash() {
    const targets = getUnifiedTrashTargets()
    if (targets.length === 0) { setPendingEmptyUnifiedTrash(null); return }
    let purgedTotal = 0
    const failures = []
    for (const { account, folder } of targets) {
      try {
        const params = new URLSearchParams({ tenantId: account.tenant_id })
        const result = await apiFetch(`/mail/accounts/${account.id}/folders/${folder.id}/trash?${params.toString()}`, {
          method: 'DELETE',
        })
        purgedTotal += Number(result?.count || 0)
        // 계정별 휴지통 카운트 0으로 낙관적 갱신
        setAccounts(prev => prev.map(item => (
          item.id !== account.id ? item : {
            ...item,
            folders: (item.folders || []).map(f => (f.id === folder.id ? { ...f, message_count: 0, unread_count: 0 } : f)),
          }
        )))
      } catch (err) {
        const label = getAccountLabel(account) || account.email_address || account.id
        failures.push({ label, message: err.message || '알 수 없는 오류' })
        console.warn(`[통합 휴지통 비우기] ${account.email_address} 실패: ${err.message}`)
      }
    }
    // 통합 휴지통 뷰를 보고 있었다면 목록 비움
    if (resolveActiveUnified()?.key === 'trash') {
      setMessages([])
      clearMailSelection()
      setHasMoreMessages(false)
    }
    // 실패 시 어떤 계정이 왜 실패했는지 함께 노출한다.
    setMessagesError(
      failures.length > 0
        ? `일부 계정의 휴지통을 비우지 못했습니다. (${failures.length}개 실패) — `
          + failures.map(f => `${f.label}: ${f.message}`).join(' / ')
        : '',
    )
    setPendingEmptyUnifiedTrash(null)
  }

  function openFolderNameDialog(config) {
    setFolderNameDialog(config)
    setFolderNameDialogLoading(false)
  }

  async function confirmFolderNameDialog(name) {
    const handler = folderNameDialog?.onSubmit
    if (!handler) return
    setFolderNameDialogLoading(true)
    try {
      await handler(name)
      setFolderNameDialog(null)
    } catch (err) {
      setMessagesError(err.message || '작업을 완료하지 못했습니다.')
    } finally {
      setFolderNameDialogLoading(false)
    }
  }

  function createMailFolder(menu, parentFolder = null) {
    const fm = mt.folderMenu
    openFolderNameDialog({
      title: parentFolder ? fm.newSubFolderTitle : fm.newFolderTitle,
      message: parentFolder ? fm.newSubFolderMessage : fm.newFolderMessage,
      initialValue: '',
      onSubmit: name => submitCreateMailFolder(menu, parentFolder, name),
    })
  }

  async function submitCreateMailFolder(menu, parentFolder = null, cleanName) {
    const account = menu?.account
    if (!account?.id || !account?.tenant_id) return
    try {
      const params = new URLSearchParams({ tenantId: account.tenant_id })
      const result = await apiFetch(`/mail/accounts/${account.id}/folders?${params.toString()}`, {
        method: 'POST',
        body: JSON.stringify({
          tenantId: account.tenant_id,
          name: cleanName,
          parentFolderId: parentFolder?.id || '',
        }),
      })
      const folder = result?.folder
      if (!folder?.id) return
      setAccounts(prev => prev.map(item => (
        item.id === account.id
          ? { ...item, folders: [...(item.folders || []).filter(existing => existing.id !== folder.id), folder] }
          : item
      )))
      updateActiveKey(`${account.id}:${folder.id}`)
      setComposeMode(false)
    } catch (err) {
      throw new Error(err.message || '폴더를 추가하지 못했습니다.')
    }
  }

  // 폴더 삭제: 네이티브 confirm 대신 ConfirmDialog로 확인을 받는다. 실제 삭제는 performDeleteMailFolder.
  function deleteMailFolder(menu) {
    const account = menu?.account
    const folder = menu?.folder
    if (!account?.id || !folder?.id || !account?.tenant_id || isSystemMailFolder(folder)) return
    // 프로바이더별 파괴성이 다르므로 확인 문구를 분기한다. (MailService.md 16.11)
    //   - Gmail(라벨 삭제, 비파괴): 메일은 전체보관함에 남는다.
    //   - IMAP(메일함 삭제, 파괴적): 폴더와 그 안의 메일이 서버에서 영구 삭제된다.
    const label = getMailFolderLabel(folder)
    const msgCount = Number(folder.message_count || 0)
    let message
    if (folder.is_local) {
      message = `"${label}" 폴더를 삭제하시겠습니까?`
    } else if (account.provider === 'gmail') {
      message = `"${label}" 라벨을 삭제합니다.\n메일은 삭제되지 않고 전체보관함에 남습니다.`
    } else {
      message = `"${label}" 폴더${msgCount > 0 ? `와 그 안의 메일 ${msgCount}개` : ''}가 서버에서 영구 삭제됩니다.\n이 작업은 복구할 수 없습니다.`
    }
    setPendingDeleteFolder({ account, folder, message, danger: !folder.is_local })
  }

  async function performDeleteMailFolder(pending) {
    if (!pending) return
    const { account, folder } = pending
    setPendingDeleteFolder(null)
    try {
      const params = new URLSearchParams({ tenantId: account.tenant_id })
      const result = await apiFetch(`/mail/accounts/${account.id}/folders/${folder.id}?${params.toString()}`, {
        method: 'DELETE',
      })
      setAccounts(prev => prev.map(item => (
        item.id === account.id
          ? { ...item, folders: (item.folders || []).filter(existing => existing.id !== folder.id && existing.parent_folder_id !== folder.id) }
          : item
      )))
      const active = resolveActiveFolder()
      if (active?.folder?.id === folder.id) {
        updateActiveKey(`${UNIFIED_KEY_PREFIX}inbox`)
        setMessages([])
        clearMailSelection()
      }
      if (Number(result?.purgedMessages || 0) > 0) {
        setMessagesError(`폴더를 삭제했습니다. (메일 ${result.purgedMessages}개 영구 삭제)`)
      }
    } catch (err) {
      // 서버가 영구 거부(server_rejected)한 폴더만 백엔드가 deletable=false로 학습한다.
      // has_children(하위 폴더 정리 후 삭제 가능)은 학습하지 않으므로 로컬 상태도 건드리지 않는다.
      // 로컬 상태도 즉시 반영해 재조회 없이 삭제 메뉴가 비활성화되도록 한다. (folder_delete_error.md 2번, MailService.md 22)
      if (err.status === 409 && err.reason !== 'has_children') {
        setAccounts(prev => prev.map(item => (
          item.id === account.id
            ? { ...item, folders: (item.folders || []).map(existing => (
                existing.id === folder.id ? { ...existing, deletable: false } : existing
              )) }
            : item
        )))
      }
      setMessagesError(err.message || '폴더를 삭제하지 못했습니다.')
    }
  }

  async function setMailFolderColor(menu, colorKey) {
    const account = menu?.account
    const folder = menu?.folder
    if (!account?.id || !folder?.id || !account?.tenant_id) return
    try {
      const params = new URLSearchParams({ tenantId: account.tenant_id })
      const result = await apiFetch(`/mail/accounts/${account.id}/folders/${folder.id}?${params.toString()}`, {
        method: 'PATCH',
        body: JSON.stringify({ tenantId: account.tenant_id, colorKey }),
      })
      const nextFolder = result?.folder || { ...folder, color_key: colorKey || null }
      setAccounts(prev => prev.map(item => (
        item.id === account.id
          ? {
              ...item,
              folders: (item.folders || []).map(existing => (
                existing.id === folder.id ? { ...existing, color_key: nextFolder.color_key || null } : existing
              )),
            }
          : item
      )))
    } catch (err) {
      setMessagesError(err.message || '폴더 색상을 변경하지 못했습니다.')
    }
  }

  // 폴더 이름 변경 — 로컬 전용은 DB만, 프로바이더 폴더는 서버가 프로바이더에 반영. (MailService.md 16)
  function renameMailFolder(menu) {
    const account = menu?.account
    const folder = menu?.folder
    if (!account?.id || !folder?.id || !account?.tenant_id) return
    const fm = mt.folderMenu
    openFolderNameDialog({
      title: fm.renameFolderTitle,
      message: fm.renameFolderMessage,
      initialValue: folder.name || '',
      onSubmit: name => submitRenameMailFolder(menu, name),
    })
  }

  async function submitRenameMailFolder(menu, newName) {
    const account = menu?.account
    const folder = menu?.folder
    if (!account?.id || !folder?.id || !account?.tenant_id) return
    if (!newName || newName === (folder.name || '')) return
    try {
      const params = new URLSearchParams({ tenantId: account.tenant_id })
      const result = await apiFetch(`/mail/accounts/${account.id}/folders/${folder.id}?${params.toString()}`, {
        method: 'PATCH',
        body: JSON.stringify({ tenantId: account.tenant_id, name: newName }),
      })
      const nextFolder = result?.folder || { ...folder, name: newName }
      setAccounts(prev => prev.map(item => (
        item.id === account.id
          ? {
              ...item,
              folders: (item.folders || []).map(existing => (
                existing.id === folder.id
                  ? { ...existing, name: nextFolder.name, provider_folder_id: nextFolder.provider_folder_id || existing.provider_folder_id }
                  : existing
              )),
            }
          : item
      )))
    } catch (err) {
      throw new Error(err.message || '폴더 이름을 변경하지 못했습니다.')
    }
  }

  function setUnifiedFolderColor(menu, colorKey) {
    const folder = menu?.folder
    if (!folder?.key || !currentTenantId) return
    const storageKey = `${currentTenantId}:${folder.key}`
    setUnifiedFolderColors(prev => {
      const next = { ...prev }
      if (colorKey) next[storageKey] = colorKey
      else delete next[storageKey]
      try {
        window.localStorage.setItem(UNIFIED_FOLDER_COLOR_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // localStorage가 막힌 환경에서는 현재 화면 상태만 유지한다.
      }
      return next
    })
  }

  async function markMessageUnread(target) {
    const active = resolveActiveFolder()
    const targets = getActionMessages(target)
    const tenantId = targets[0]?.tenant_id || active?.account?.tenant_id || currentTenantId
    if (!tenantId || targets.length === 0) return
    try {
      const params = new URLSearchParams({ tenantId })
      await apiFetch(`/mail/messages/bulk?${params.toString()}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'mark_unread', messageIds: targets.map(item => item.id) }),
      })
      const targetIds = new Set(targets.map(item => item.id))
      setMessages(prev => prev.map(item => (
        targetIds.has(item.id) ? { ...item, is_read: false } : item
      )))
      setSelectedMessage(prev => (
        prev && targetIds.has(prev.id) ? { ...prev, is_read: false } : prev
      ))
      for (const message of targets) {
        if (message.is_read) {
          adjustFolderCounts({ accountId: message.account_id, folderId: message.folder_id, unreadDelta: 1 })
        }
      }
    } catch (err) {
      setMessagesError(err.message || '메일 상태를 변경하지 못했습니다.')
    }
  }

  // 중요(별표) 토글 — 선택 묶음 전체를 starred로 설정/해제. (MailService.md 14)
  async function toggleMessagesStarred(target, starred) {
    const active = resolveActiveFolder()
    const targets = getActionMessages(target)
    const tenantId = targets[0]?.tenant_id || active?.account?.tenant_id || currentTenantId
    if (!tenantId || targets.length === 0) return
    try {
      const params = new URLSearchParams({ tenantId })
      await apiFetch(`/mail/messages/bulk?${params.toString()}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: starred ? 'star' : 'unstar', messageIds: targets.map(item => item.id) }),
      })
      const targetIds = new Set(targets.map(item => item.id))
      setMessages(prev => {
        const next = prev.map(item => (targetIds.has(item.id) ? { ...item, is_starred: starred } : item))
        // 별표됨 뷰에서 '해제'하면 조건을 벗어나므로 목록에서 제거한다.
        return resolveActiveUnified()?.key === 'starred' && !starred
          ? next.filter(item => !targetIds.has(item.id))
          : next
      })
      setSelectedMessage(prev => (prev && targetIds.has(prev.id) ? { ...prev, is_starred: starred } : prev))
      // 별표됨 사이드바 배지를 낙관적으로 갱신한다. (이미 목표 상태인 건은 서버가 no-op이므로 카운트 변화 없음)
      for (const message of targets) {
        if (!!message.is_starred === starred) continue
        adjustFolderCounts({
          accountId: message.account_id,
          folderId: message.folder_id,
          starredDelta: starred ? 1 : -1,
          starredUnreadDelta: message.is_read ? 0 : (starred ? 1 : -1),
        })
      }
    } catch (err) {
      setMessagesError(err.message || '중요 표시를 변경하지 못했습니다.')
    }
  }

  async function deleteMessage(target) {
    const active = resolveActiveFolder()
    const targets = getActionMessages(target)
    const tenantId = targets[0]?.tenant_id || active?.account?.tenant_id || currentTenantId
    if (!tenantId || targets.length === 0) return
    const targetIds = new Set(targets.map(item => String(item.id)))
    const snapshotMessages = messages
    const snapshotSelectedMessage = selectedMessage
    const snapshotSelectedMessageIds = selectedMessageIds

    setLastSelectedMessageId(null)
    setMessages(prev => prev.filter(item => !targetIds.has(String(item.id))))
    setSelectedMessage(prev => (prev && targetIds.has(String(prev.id)) ? null : prev))
    setSelectedMessageIds(prev => prev.filter(id => !targetIds.has(String(id))))
    setMessagesError('')
    for (const message of targets) {
      adjustFolderCounts({
        accountId: message.account_id,
        folderId: message.folder_id,
        totalDelta: -1,
        unreadDelta: message.is_read ? 0 : -1,
      })
    }

    try {
      const params = new URLSearchParams({ tenantId })
      const result = await apiFetch(`/mail/messages/bulk?${params.toString()}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'delete', messageIds: targets.map(item => item.id) }),
      })
      const resultById = new Map((result?.results || []).map(item => [item.id, item]))
      const successTargets = targets.filter(message => resultById.get(message.id)?.ok)
      const failedTargets = targets.filter(message => !resultById.get(message.id)?.ok)
      const failedIds = new Set(failedTargets.map(item => String(item.id)))

      if (failedTargets.length > 0) {
        setMessages(prev => restoreMessagesBySnapshot(prev, snapshotMessages, failedIds))
        if (snapshotSelectedMessage && failedIds.has(String(snapshotSelectedMessage.id))) {
          setSelectedMessage(snapshotSelectedMessage)
        }
        setSelectedMessageIds(prev => {
          const existing = new Set(prev.map(String))
          const restoredIds = snapshotSelectedMessageIds.filter(id => failedIds.has(String(id)) && !existing.has(String(id)))
          return [...prev, ...restoredIds]
        })
        for (const message of failedTargets) {
          adjustFolderCounts({
            accountId: message.account_id,
            folderId: message.folder_id,
            totalDelta: 1,
            unreadDelta: message.is_read ? 0 : 1,
          })
        }
      }

      for (const message of successTargets) {
        const resultItem = resultById.get(message.id)
        const targetFolderId = resultItem?.message?.trash_folder_id || resultItem?.message?.folder_id
        if (targetFolderId && targetFolderId !== message.folder_id && !resultItem?.message?.soft_deleted) {
          adjustFolderCounts({
            accountId: message.account_id,
            folderId: targetFolderId,
            totalDelta: 1,
            unreadDelta: message.is_read ? 0 : 1,
          })
        }
      }
      // 삭제/휴지통 이동은 스마트 폴더 태그 집계에서도 빠지므로 배지를 갱신한다. (MailService.md 13)
      await reloadSmartFolders().catch(() => {})
      setMessagesError(failedTargets.length > 0 ? '일부 메일을 삭제하지 못했습니다.' : '')
    } catch (err) {
      setMessages(prev => restoreMessagesBySnapshot(prev, snapshotMessages, targetIds))
      setSelectedMessage(snapshotSelectedMessage)
      setSelectedMessageIds(snapshotSelectedMessageIds)
      for (const message of targets) {
        adjustFolderCounts({
          accountId: message.account_id,
          folderId: message.folder_id,
          totalDelta: 1,
          unreadDelta: message.is_read ? 0 : 1,
        })
      }
      setMessagesError(err.message || '메일을 삭제하지 못했습니다.')
    }
  }

  async function moveMessage(target, folder) {
    const active = resolveActiveFolder()
    const targets = getActionMessages(target).filter(item => item.folder_id !== folder?.id)
    const tenantId = targets[0]?.tenant_id || active?.account?.tenant_id || currentTenantId
    if (!tenantId || targets.length === 0 || !folder?.id) return
    try {
      const params = new URLSearchParams({ tenantId })
      const data = await apiFetch(`/mail/messages/bulk?${params.toString()}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'move', targetFolderId: folder.id, messageIds: targets.map(item => item.id) }),
      })
      // 서버가 실제로 이동에 성공한 건만 반영한다. 실패 건은 목록에서 지우지 않아
      // "원본·대상 양쪽에서 사라지는" 현상을 막는다. (MailService.md 11.5.1)
      const movedIds = new Set(
        (Array.isArray(data?.results) ? data.results : [])
          .filter(item => item?.ok)
          .map(item => String(item.id)),
      )
      const moved = targets.filter(item => movedIds.has(String(item.id)))
      if (moved.length === 0) {
        setMessagesError('메일을 이동하지 못했습니다. (대상 폴더/계정을 확인하세요)')
        return
      }
      const movedSet = new Set(moved.map(item => item.id))
      setLastSelectedMessageId(null)
      setMessages(prev => prev.filter(item => !movedSet.has(item.id)))
      setSelectedMessage(prev => (prev && movedSet.has(prev.id) ? null : prev))
      setSelectedMessageIds(prev => prev.filter(id => !movedSet.has(id)))
      for (const message of moved) {
        adjustFolderCounts({
          accountId: message.account_id,
          folderId: message.folder_id,
          totalDelta: -1,
          unreadDelta: message.is_read ? 0 : -1,
        })
        adjustFolderCounts({
          accountId: message.account_id,
          folderId: folder.id,
          totalDelta: 1,
          unreadDelta: message.is_read ? 0 : 1,
        })
      }
      // 휴지통/스팸으로 이동하면 스마트 폴더 집계에서 빠지므로 배지를 갱신한다. (MailService.md 13)
      await reloadSmartFolders().catch(() => {})
      setMessagesError(moved.length < targets.length ? '일부 메일을 이동하지 못했습니다.' : '')
    } catch (err) {
      setMessagesError(err.message || '메일을 이동하지 못했습니다.')
    }
  }

  // 드롭 유효 타깃: 실제 폴더(folder.id 보유)만. 서버에 없는 로컬 표시 폴더(missing)는 제외. (MailService.md 11.4)
  function isDroppableFolder(folder) {
    return Boolean(folder?.id) && folder.sync_status !== 'missing'
  }

  // 폴더 버튼 위 dragover: 커스텀 MIME(메일 id 목록)일 때만 드롭을 허용하고 하이라이트한다.
  function handleFolderDragOver(event, folder, key) {
    if (!isDroppableFolder(folder) || !event.dataTransfer.types.includes('application/x-mail-ids')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (dropTargetKey !== key) setDropTargetKey(key)
  }

  function handleFolderDragLeave(event, key) {
    // 버튼 내부 자식으로 이동하는 경우(relatedTarget 포함)는 유지, 완전히 벗어날 때만 해제한다.
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setDropTargetKey(prev => (prev === key ? null : prev))
    }
  }

  // 폴더 버튼에 드롭: id 목록을 파싱해 기존 moveMessage로 이동한다(다중/단건 규칙은 이미 반영). (MailService.md 11.2)
  function handleFolderDrop(event, folder) {
    setDropTargetKey(null)
    if (!isDroppableFolder(folder)) return
    const raw = event.dataTransfer.getData('application/x-mail-ids')
    if (!raw) return
    event.preventDefault()
    let ids
    try { ids = JSON.parse(raw) } catch { return }
    if (!Array.isArray(ids) || ids.length === 0) return
    moveMessage({ targetIds: ids }, folder)
  }

  // 통합 메뉴는 여러 계정을 집계한 가상 항목이라 단일 folder.id가 없다.
  // 드롭 시 각 메일의 계정 안에서 type(inbox/trash) 또는 이름으로 실제 폴더를 해석한다. (MailService.md 11.5.1)
  function resolveUnifiedTargetFolder(account, item) {
    const folders = account?.folders || []
    if (item?.type) return folders.find(folder => String(folder.type || '') === item.type) || null
    if (item?.folderName) {
      const target = normalizeFolderName(item.folderName)
      return folders.find(folder => normalizeFolderName(folder.name) === target) || null
    }
    return null
  }

  // 통합 메뉴 유효 드롭 타깃: 받은 편지함·휴지통·사용자 지정 이름 폴더만.
  // 모든 편지함/별표됨/검색은 실제 대상이 없어 제외, 보낸 메일/임시 보관함은 의미 모호로 1차 제외. (MailService.md 11.5.1)
  function isDroppableUnified(item) {
    if (!item) return false
    if (item.type === 'inbox' || item.type === 'trash') return true
    return Boolean(item.folderName) && String(item.key || '').startsWith('name:')
  }

  // 선택이 여러 계정에 걸칠 수 있으므로, 해석된 대상 folder.id 기준으로 그룹핑해 그룹마다 기존 moveMessage로 이동한다.
  async function moveMessagesToUnified(ids, item) {
    const idSet = new Set(ids)
    const targets = messages.filter(message => idSet.has(message.id))
    if (targets.length === 0) return
    const groups = new Map()
    for (const message of targets) {
      const account = accounts.find(acc => acc.id === message.account_id)
      const folder = resolveUnifiedTargetFolder(account, item)
      if (!folder?.id || folder.id === message.folder_id) continue
      const group = groups.get(folder.id) || { folder, ids: [] }
      group.ids.push(message.id)
      groups.set(folder.id, group)
    }
    for (const group of groups.values()) {
      await moveMessage({ targetIds: group.ids }, group.folder)
    }
  }

  function handleUnifiedDragOver(event, item, key) {
    if (!isDroppableUnified(item) || !event.dataTransfer.types.includes('application/x-mail-ids')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (dropTargetKey !== key) setDropTargetKey(key)
  }

  function handleUnifiedDrop(event, item) {
    setDropTargetKey(null)
    if (!isDroppableUnified(item)) return
    const raw = event.dataTransfer.getData('application/x-mail-ids')
    if (!raw) return
    event.preventDefault()
    let ids
    try { ids = JSON.parse(raw) } catch { return }
    if (!Array.isArray(ids) || ids.length === 0) return
    moveMessagesToUnified(ids, item)
  }

  // 스마트 폴더 드롭(MailService.md 13.4/13.5): 이동이 아니라 "태그 부여 + 각 계정 내 아카이브".
  function handleSmartDragOver(event, key) {
    if (!event.dataTransfer.types.includes('application/x-mail-ids')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    if (dropTargetKey !== key) setDropTargetKey(key)
  }

  function handleSmartDrop(event, smartFolder) {
    setDropTargetKey(null)
    const raw = event.dataTransfer.getData('application/x-mail-ids')
    if (!raw) return
    event.preventDefault()
    let ids
    try { ids = JSON.parse(raw) } catch { return }
    if (!Array.isArray(ids) || ids.length === 0) return
    const sourceSmart = resolveActiveSmart()
    if (sourceSmart && sourceSmart.id === smartFolder.id) return // 같은 스마트 폴더로 드롭 = 무동작
    if (sourceSmart) {
      // 스마트 폴더 → 스마트 폴더: "이동"으로 처리(대상 태그 + 원본 태그 해제, 아카이브 안 함).
      moveMessagesBetweenSmartFolders(ids, sourceSmart, smartFolder)
    } else {
      // 그 외(받은편지함/폴더/통합)에서 스마트 폴더로: 태그 부여 + 각 계정 내 아카이브.
      tagMessagesToSmartFolder(ids, smartFolder, { archive: true })
    }
  }

  // 태그 부여(+아카이브) 실행. archive면 각 메일을 자기 계정 보관함으로 이동해 목록/카운트를 갱신한다.
  async function tagMessagesToSmartFolder(ids, smartFolder, { archive = false } = {}) {
    if (!smartFolder?.id || !currentTenantId) return
    try {
      const data = await apiFetch(`/mail/smart-folders/${smartFolder.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ tenantId: currentTenantId, messageIds: ids, archive }),
      })
      const archivedSet = new Set(Array.isArray(data?.archived) ? data.archived : [])
      // 아카이브된 메일은 원 폴더에서 빠졌으므로, 현재 뷰가 스마트 폴더가 아니면 목록에서 제거한다.
      const viewingThisSmart = activeKey === `${SMART_KEY_PREFIX}${smartFolder.id}`
      if (archivedSet.size > 0 && !viewingThisSmart) {
        setLastSelectedMessageId(null)
        setMessages(prev => prev.filter(item => !archivedSet.has(item.id)))
        setSelectedMessage(prev => (prev && archivedSet.has(prev.id) ? null : prev))
      }
      setSelectedMessageIds(prev => prev.filter(id => !archivedSet.has(id)))
      // 리스트에 남아 있는(아카이브로 빠지지 않은) 메일에는 태그 칩을 낙관적으로 추가한다(18.5).
      const taggedSet = new Set(Array.isArray(data?.tagged) ? data.tagged : ids)
      const tagChip = { id: smartFolder.id, name: smartFolder.name, color_key: smartFolder.color_key ?? null }
      setMessages(prev => prev.map(item => {
        if (!taggedSet.has(item.id) || archivedSet.has(item.id)) return item
        const existing = Array.isArray(item.tags) ? item.tags : []
        if (existing.some(tag => tag.id === tagChip.id)) return item
        return { ...item, tags: [...existing, tagChip] }
      }))
      // 스마트 폴더 카운트 + (아카이브로 원 폴더가 줄었으면) 계정 폴더 카운트 갱신
      await reloadSmartFolders().catch(() => {})
      if (archivedSet.size > 0) await reloadMailAccounts().catch(() => {})
      const taggedCount = Array.isArray(data?.tagged) ? data.tagged.length : 0
      showToast?.({
        message: taggedCount > 0
          ? `${taggedCount}개를 "${smartFolder.name}"에 담았습니다${archivedSet.size ? ` (${archivedSet.size}개 보관함 이동)` : ''}.`
          : `이미 "${smartFolder.name}"에 담겨 있습니다.`,
        tone: taggedCount > 0 ? 'success' : 'default',
      })
    } catch (err) {
      setMessagesError(err.message || '스마트 폴더에 담지 못했습니다.')
    }
  }

  // 스마트 폴더 간 이동: 대상 스마트 폴더에 태그하고, 원본(현재 보던) 스마트 폴더에서 태그를 해제한다.
  // 계정 폴더/프로바이더는 건드리지 않는다(아카이브 없음) — 스마트 폴더 소속만 재구성.
  async function moveMessagesBetweenSmartFolders(ids, sourceSmart, targetSmart) {
    if (!sourceSmart?.id || !targetSmart?.id || !currentTenantId) return
    try {
      await apiFetch(`/mail/smart-folders/${targetSmart.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ tenantId: currentTenantId, messageIds: ids, archive: false }),
      })
      await apiFetch(`/mail/smart-folders/${sourceSmart.id}/messages`, {
        method: 'DELETE',
        body: JSON.stringify({ tenantId: currentTenantId, messageIds: ids }),
      })
      // 현재 원본 스마트 폴더 뷰에서 이동한 메일을 목록에서 제거
      const idSet = new Set(ids)
      setLastSelectedMessageId(null)
      setMessages(prev => prev.filter(item => !idSet.has(item.id)))
      setSelectedMessage(prev => (prev && idSet.has(prev.id) ? null : prev))
      setSelectedMessageIds(prev => prev.filter(id => !idSet.has(id)))
      await reloadSmartFolders().catch(() => {})
      showToast?.({ message: `${ids.length}개를 "${sourceSmart.name}" → "${targetSmart.name}"으로 이동했습니다.`, tone: 'success' })
    } catch (err) {
      setMessagesError(err.message || '스마트 폴더 간 이동에 실패했습니다.')
    }
  }

  function toggleSmartSection() {
    setSmartSectionCollapsed(prev => {
      const next = !prev
      try { window.localStorage.setItem('mail-smart-section-collapsed', next ? '1' : '0') } catch { /* noop */ }
      return next
    })
  }

  function createSmartFolderPrompt() {
    if (!currentTenantId) return
    const fm = mt.folderMenu
    openFolderNameDialog({
      title: fm.newSmartFolderTitle,
      message: fm.newSmartFolderMessage,
      initialValue: '',
      onSubmit: submitCreateSmartFolder,
    })
  }

  async function submitCreateSmartFolder(name) {
    if (!currentTenantId) return
    try {
      await apiFetch('/mail/smart-folders', {
        method: 'POST',
        body: JSON.stringify({ tenantId: currentTenantId, name }),
      })
      await reloadSmartFolders()
    } catch (err) {
      throw new Error(err.message || '스마트 폴더를 만들지 못했습니다.')
    }
  }

  function openSmartFolderMenu(event, folder) {
    event.preventDefault()
    event.stopPropagation()
    setSmartFolderMenu({
      x: event.clientX,
      y: event.clientY,
      folder,
    })
  }

  function renameSmartFolder(folder) {
    if (!folder?.id || !currentTenantId) return
    const fm = mt.folderMenu
    openFolderNameDialog({
      title: fm.renameSmartFolderTitle,
      message: fm.renameSmartFolderMessage,
      initialValue: folder.name || '',
      onSubmit: name => submitRenameSmartFolder(folder, name),
    })
  }

  async function submitRenameSmartFolder(folder, name) {
    if (!folder?.id || !currentTenantId) return
    if (!name || name === folder.name) return
    try {
      await apiFetch(`/mail/smart-folders/${folder.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ tenantId: currentTenantId, name }),
      })
      await reloadSmartFolders()
    } catch (err) {
      throw new Error(err.message || '스마트 폴더 이름을 변경하지 못했습니다.')
    }
  }

  async function deleteSmartFolder(folder) {
    if (!folder?.id || !currentTenantId) return
    if (!window.confirm(`"${folder.name}" 스마트 폴더를 삭제할까요?\n메일 원본은 각 계정에 그대로 남고, 이 폴더의 태그만 사라집니다.`)) return
    try {
      await apiFetch(`/mail/smart-folders/${folder.id}?tenantId=${encodeURIComponent(currentTenantId)}`, { method: 'DELETE' })
      if (activeKey === `${SMART_KEY_PREFIX}${folder.id}`) updateActiveKey(`${UNIFIED_KEY_PREFIX}all`)
      await reloadSmartFolders()
    } catch (err) {
      setMessagesError(err.message || '스마트 폴더를 삭제하지 못했습니다.')
    }
  }

  async function setSmartFolderColor(folder, colorKey) {
    if (!folder?.id || !currentTenantId) return
    try {
      await apiFetch(`/mail/smart-folders/${folder.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ tenantId: currentTenantId, color_key: colorKey || '' }),
      })
      await reloadSmartFolders()
    } catch (err) {
      setMessagesError(err.message || '색상을 변경하지 못했습니다.')
    }
  }

  async function registerAgenticWatch(target) {
    const active = resolveActiveFolder()
    const message = target?.message
    const account = accounts.find(item => item.id === message?.account_id) || active?.account
    if (!message?.id || !account?.tenant_id) return
    try {
      await apiFetch('/mail/agentic/watch-targets', {
        method: 'POST',
        body: JSON.stringify({
          tenantId: account.tenant_id,
          target_type: 'condition_group',
          account_conditions: [account.email_address || message.account_id].filter(Boolean),
          keyword_conditions: [],
          subject_conditions: [normalizeMailThreadSubject(message.subject || '')].filter(Boolean),
          condition_match_type: 'contains',
          notify_telegram: true,
          auto_create_todos: true,
          message_id: message.id,
        }),
      })
      setMessagesError('')
    } catch (err) {
      setMessagesError(err.message || 'AgenticAI 모니터링 등록에 실패했습니다.')
    }
  }

  async function loadActiveMessages(sourceAccounts = accounts, options = {}) {
    setComposeMode(false)
    const { silent = false, resetSelection = true } = options
    const requestSeq = ++messageLoadSeqRef.current
    const request = buildActiveMessageRequest(sourceAccounts)
    const latestViewKeyForRequest = () => buildMessageViewKey(
      activeKeyRef.current,
      request?.kind === 'folder' ? request.tenantId : currentTenantIdRef.current,
    )
    const isCurrentRequest = () => (
      requestSeq === messageLoadSeqRef.current
      && request?.viewKey
      && request.viewKey === latestViewKeyForRequest()
    )
    if (!request) {
      setMessages([])
      setMessagesError('')
      setSelectedMessage(null)
      setSelectedMessageIds([])
      setLastSelectedMessageId(null)
      setMessageDetailError('')
      setHasMoreMessages(false)
      return
    }
    if (!silent) setMessagesLoading(true)
    setMessagesError('')
    try {
      const rows = await apiFetch(`/mail/messages?${request.params.toString()}`)
      if (!isCurrentRequest()) return
      const list = Array.isArray(rows) ? rows : []
      const preserved = preserveSelectionOnNextLoadRef.current
      const nextList = preserved?.id
        ? (
            list.some(item => item.id === preserved.id)
              ? list.map(item => (item.id === preserved.id ? { ...item, ...preserved.message } : item))
              : [preserved.message, ...list]
          )
        : list
      setMessages(nextList)
      setHasMoreMessages(list.length === MAIL_PAGE_SIZE)
      if (resetSelection) {
        if (preserved?.id) {
          setSelectedMessage(preserved.message)
          setSelectedMessageIds([preserved.id])
          setLastSelectedMessageId(null)
          setMessageDetailError('')
          preserveSelectionOnNextLoadRef.current = null
        } else {
          setSelectedMessage(null)
          setSelectedMessageIds([])
          setLastSelectedMessageId(null)
          setMessageDetailError('')
        }
      }
    } catch (err) {
      if (!isCurrentRequest()) return
      setMessagesError(err.message || '메일 목록을 불러오지 못했습니다.')
    } finally {
      if (!silent && requestSeq === messageLoadSeqRef.current) setMessagesLoading(false)
    }
  }

  // 무한 스크롤: 다음 페이지를 이어서 불러온다.
  async function loadMoreMessages() {
    const active = resolveActiveFolder()
    const unified = resolveActiveUnified()
    const smartFolderId = activeKey.startsWith(SMART_KEY_PREFIX) ? activeKey.slice(SMART_KEY_PREFIX.length) : ''
    const tenantId = currentTenantId
    if ((!active && !unified && !smartFolderId) || loadingMore || messagesLoading || !hasMoreMessages) return
    if (smartFolderId && !tenantId) return
    const requestSeq = ++loadMoreSeqRef.current
    const requestOffset = messages.length
    const requestKind = active ? 'folder' : smartFolderId ? 'smart' : 'unified'
    const requestTenantId = active ? active.account.tenant_id : tenantId
    const requestViewKey = buildMessageViewKey(activeKey, requestTenantId)
    const latestViewKeyForRequest = () => buildMessageViewKey(
      activeKeyRef.current,
      requestKind === 'folder' ? requestTenantId : currentTenantIdRef.current,
    )
    const isCurrentRequest = () => (
      requestSeq === loadMoreSeqRef.current
      && requestViewKey
      && requestViewKey === latestViewKeyForRequest()
      && requestOffset === messagesLengthRef.current
    )
    setLoadingMore(true)
    try {
      const params = active
        ? new URLSearchParams({
            tenantId: active.account.tenant_id,
            accountId: active.account.id,
            folderId: active.folder.id,
            limit: String(MAIL_PAGE_SIZE),
            offset: String(messages.length),
          })
        : smartFolderId
          ? new URLSearchParams({
              tenantId,
              scope: 'smart',
              smartFolderId,
              limit: String(MAIL_PAGE_SIZE),
              offset: String(messages.length),
            })
          : new URLSearchParams({
            tenantId,
            scope: 'unified',
            unifiedKey: unified.key,
            folderType: unified.type || '',
            folderName: unified.folderName || '',
            limit: String(MAIL_PAGE_SIZE),
            offset: String(messages.length),
          })
      const rows = await apiFetch(`/mail/messages?${params.toString()}`)
      if (!isCurrentRequest()) return
      const list = Array.isArray(rows) ? rows : []
      setMessages(prev => {
        const existingIds = new Set(prev.map(item => String(item.id)))
        const uniqueList = list.filter(item => !existingIds.has(String(item.id)))
        return [...prev, ...uniqueList]
      })
      setHasMoreMessages(list.length === MAIL_PAGE_SIZE)
    } catch {
      // 추가 로드 실패는 다음 스크롤에서 재시도
    } finally {
      if (requestSeq === loadMoreSeqRef.current) setLoadingMore(false)
    }
  }

  function handleMessagesScroll(e) {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) {
      loadMoreMessages()
    }
  }

  async function refreshMail() {
    setRefreshLoading(true)
    setMessagesError('')
    try {
      await apiFetch('/mail/sync-all', {
        method: 'POST',
        body: JSON.stringify({ full: true }),
      })
      const nextAccounts = await reloadMailAccounts()
      await loadActiveMessages(nextAccounts, { silent: true, resetSelection: false })
    } catch (err) {
      setMessagesError(err.message || '메일 새로고침에 실패했습니다.')
    } finally {
      setRefreshLoading(false)
    }
  }

  useEffect(() => {
    if (!selectedMessage?.id || composeMode) return undefined
    const tenantId = selectedMessage.tenant_id || currentTenantId
    if (!tenantId) return undefined
    let cancelled = false
    setMessageDetailLoading(true)
    setMessageDetailError('')
    const params = new URLSearchParams({ tenantId, targetLanguage: language || 'ko' })
    apiFetch(`/mail/messages/${selectedMessage.id}?${params.toString()}`)
      .then(detail => {
        if (cancelled) return
        setSelectedMessage(detail)
      })
      .catch(err => {
        if (cancelled) return
        setMessageDetailError(err.message || '메일 본문을 불러오지 못했습니다.')
      })
      .finally(() => {
        if (!cancelled) setMessageDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [language])

  useEffect(() => {
    const messageId = String(initialMailLink?.messageId || '').trim()
    const tenantId = String(initialMailLink?.tenantId || '').trim()
    const targetLanguage = String(initialMailLink?.targetLanguage || language || 'ko').trim() || 'ko'
    const openedAt = String(initialMailLink?.openedAt || '').trim()
    if (!messageId || !tenantId) return
    const signature = `${tenantId}:${messageId}:${targetLanguage}:${openedAt}`
    if (handledInitialMailLinkRef.current === signature) return

    let cancelled = false
    async function openLinkedMail() {
      setComposeMode(false)
      setSelectedMessageIds([messageId])
      setLastSelectedMessageId(null)
      preserveSelectionOnNextLoadRef.current = null
      setMessageDetailLoading(true)
      setMessageDetailError('')
      try {
        const params = new URLSearchParams({ tenantId, targetLanguage })
        const detail = await apiFetch(`/mail/messages/${messageId}?${params.toString()}`)
        if (cancelled) return
        handledInitialMailLinkRef.current = signature
        const detailActiveKey = detail?.account_id && detail?.folder_id
          ? `${detail.account_id}:${detail.folder_id}`
          : ''
        if (detailActiveKey && detailActiveKey !== activeKey) {
          preserveSelectionOnNextLoadRef.current = { id: detail.id, message: detail }
          updateActiveKey(detailActiveKey)
        }
        setMessages(prev => {
          const exists = prev.some(item => item.id === detail.id)
          if (exists) return prev.map(item => (item.id === detail.id ? { ...item, ...detail } : item))
          return [detail, ...prev]
        })
        setSelectedMessage(detail)
      } catch (err) {
        if (!cancelled) setMessageDetailError(err.message || '메일 본문을 불러오지 못했습니다.')
      } finally {
        if (!cancelled) setMessageDetailLoading(false)
      }
    }

    openLinkedMail()
    return () => {
      cancelled = true
    }
  }, [initialMailLink?.messageId, initialMailLink?.tenantId, initialMailLink?.targetLanguage, initialMailLink?.openedAt, language])

  async function selectMessage(message, index, event) {
    const active = resolveActiveFolder()
    const tenantId = message?.tenant_id || active?.account?.tenant_id || currentTenantId
    if (!tenantId || !message?.id) return
    setComposeMode(false)
    const anchorIndex = lastSelectedMessageId
      ? displayedMessages.findIndex(item => String(item.id) === String(lastSelectedMessageId))
      : -1
    const currentIndex = displayedMessages.findIndex(item => String(item.id) === String(message.id))
    if (event?.shiftKey && anchorIndex >= 0 && currentIndex >= 0) {
      const start = Math.min(anchorIndex, currentIndex)
      const end = Math.max(anchorIndex, currentIndex)
      setSelectedMessageIds(displayedMessages.slice(start, end + 1).map(item => item.id))
    } else {
      setSelectedMessageIds([message.id])
      setLastSelectedMessageId(message.id)
    }
    setMessageDetailLoading(true)
    setMessageDetailError('')
    try {
      const params = new URLSearchParams({ tenantId, targetLanguage: language || 'ko' })
      const detail = await apiFetch(`/mail/messages/${message.id}?${params.toString()}`)
      if (detail?.read_status_changed) {
        markMessageReadInState(message)
      }
      setSelectedMessage(detail)
    } catch (err) {
      setMessageDetailError(err.message || '메일 본문을 불러오지 못했습니다.')
    } finally {
      setMessageDetailLoading(false)
    }
  }

  async function openDraftForEditing(message, index, event) {
    const active = resolveActiveFolder()
    const unified = resolveActiveUnified()
    const isDraftContext = active?.folder?.type === 'drafts' || unified?.type === 'drafts'
    if (!isDraftContext || !message?.id) return
    event?.stopPropagation?.()
    setSelectedMessageIds([message.id])
    setLastSelectedMessageId(message.id)
    setMessageDetailLoading(true)
    setMessageDetailError('')
    setMessagesError('')
    try {
      const params = new URLSearchParams({ tenantId: message.tenant_id || active?.account?.tenant_id || currentTenantId })
      params.set('targetLanguage', language || 'ko')
      const detail = await apiFetch(`/mail/messages/${message.id}?${params.toString()}`)
      setComposeDraft(getDraftComposeData(detail, message.account_id || active?.account?.id))
      setSelectedMessage(null)
      setMessageMenu(null)
      setComposeMode(true)
    } catch (err) {
      setMessageDetailError(err.message || '임시 보관 메일을 불러오지 못했습니다.')
    } finally {
      setMessageDetailLoading(false)
    }
  }

  function startMailAction(action, message) {
    if (!message) return
    const active = resolveActiveFolder()
    const accountId = message.account_id || active?.account?.id || accounts[0]?.id || ''
    const ownEmails = new Set(
      accounts
        .map(account => String(account.email_address || '').trim().toLowerCase())
        .filter(Boolean),
    )
    setComposeDraft(getMailActionComposeData(message, action, accountId, ownEmails))
    setSelectedMessage(null)
    setSelectedMessageIds([])
    setLastSelectedMessageId(null)
    setMessageMenu(null)
    setMessageDetailError('')
    setComposeMode(true)
  }

  useEffect(() => {
    let cancelled = false
    const openedKey = activeKey
    ;(async () => {
      await loadActiveMessages()
      const active = resolveActiveFolder()
      // 거울(custom) 폴더만 DB 목록을 먼저 보여준 뒤 IMAP 동기화를 백그라운드로 수행한다.
      // 로컬 전용 폴더(is_local)나 서버에서 사라진 폴더(sync_status='missing')는 동기화하지 않는다.
      if (cancelled || !active || active.folder.type !== 'custom') return
      if (active.folder.is_local || active.folder.sync_status === 'missing') return
      const syncKey = `${active.account.id}:${active.folder.id}`
      const lastSyncedAt = folderSyncTimesRef.current.get(syncKey) || 0
      if (Date.now() - lastSyncedAt < FOLDER_SYNC_COOLDOWN_MS) return
      folderSyncTimesRef.current.set(syncKey, Date.now())
      try {
        const params = new URLSearchParams({ tenantId: active.account.tenant_id })
        await apiFetch(`/mail/accounts/${active.account.id}/folders/${active.folder.id}/sync?${params.toString()}`, {
          method: 'POST',
          body: JSON.stringify({}),
        })
        if (cancelled) return
        const nextAccounts = await reloadMailAccounts()
        if (!cancelled && openedKey === activeKey) {
          await loadActiveMessages(nextAccounts, { silent: true, resetSelection: false })
        }
      } catch (err) {
        folderSyncTimesRef.current.delete(syncKey)
        // 백그라운드 동기화 실패는 이미 표시된 DB 목록을 덮지 않는다(목록은 그대로 유효).
        // 재인증이 필요한 경우만 사용자에게 알린다.
        if (!cancelled && err.code === 'MAIL_REAUTH_REQUIRED') {
          setMessagesError(err.message || '메일 계정 재인증이 필요합니다.')
        } else {
          console.warn('[Mail] 폴더 백그라운드 동기화 실패:', err.message)
        }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, accounts.length])

  // 폴더/스마트 뷰에 진입할 때마다 사이드바 카운트(accounts/smartFolders)를 조용히 리로드한다.
  // 백그라운드 자동 동기화나 다른 뷰에서의 이동으로 배지가 오래된(stale) 경우를 바로잡는다.
  // accounts만 갱신(setAccounts)하므로 메일 목록은 건드리지 않아 깜박임이 없다.
  useEffect(() => {
    if (!currentTenantId || composeMode) return
    let cancelled = false
    ;(async () => {
      try {
        await reloadMailAccounts()
        if (!cancelled) await reloadSmartFolders()
      } catch { /* 배지 갱신 실패는 무시(다음 진입 때 재시도) */ }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey])

  useEffect(() => {
    if (!messageMenu) return undefined
    function closeMenu() {
      setMessageMenu(null)
    }
    function closeOnEscape(event) {
      if (event.key === 'Escape') closeMenu()
    }
    window.addEventListener('click', closeMenu)
    window.addEventListener('contextmenu', closeMenu)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('contextmenu', closeMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [messageMenu])

  useEffect(() => {
    if (!folderMenu) return undefined
    function closeMenu() {
      setFolderMenu(null)
    }
    function closeOnEscape(event) {
      if (event.key === 'Escape') closeMenu()
    }
    window.addEventListener('click', closeMenu)
    window.addEventListener('contextmenu', closeMenu)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('contextmenu', closeMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [folderMenu])

  useEffect(() => {
    if (!unifiedFolderMenu) return undefined
    function closeMenu() {
      setUnifiedFolderMenu(null)
    }
    function closeOnEscape(event) {
      if (event.key === 'Escape') closeMenu()
    }
    window.addEventListener('click', closeMenu)
    window.addEventListener('contextmenu', closeMenu)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('contextmenu', closeMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [unifiedFolderMenu])

  useEffect(() => {
    if (!smartFolderMenu) return undefined
    function closeMenu() {
      setSmartFolderMenu(null)
    }
    function closeOnEscape(event) {
      if (event.key === 'Escape') closeMenu()
    }
    window.addEventListener('click', closeMenu)
    window.addEventListener('contextmenu', closeMenu)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('contextmenu', closeMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [smartFolderMenu])

  useEffect(() => {
    function clearOnEscape(event) {
      if (event.key === 'Escape' && (selectedMessage || selectedMessageIds.length > 0)) {
        clearMailSelection()
      }
    }
    window.addEventListener('keydown', clearOnEscape)
    return () => window.removeEventListener('keydown', clearOnEscape)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMessage, selectedMessageIds.length])

  // ESC를 500ms 안에 두 번 빠르게 누르면 메인 페이지로 이동한다.
  // 모달/확인 다이얼로그가 열려 있으면 ESC는 그쪽 처리에 맡기고 이동 카운트를 초기화한다.
  useEffect(() => {
    let lastEscAt = 0
    function onDoubleEscape(event) {
      if (event.key !== 'Escape') return
      if (showAccountModal || pendingEmptyTrash || pendingEmptyUnifiedTrash) {
        lastEscAt = 0
        return
      }
      const now = Date.now()
      if (now - lastEscAt <= 500) {
        lastEscAt = 0
        onBackToMain?.()
      } else {
        lastEscAt = now
      }
    }
    window.addEventListener('keydown', onDoubleEscape)
    return () => window.removeEventListener('keydown', onDoubleEscape)
  }, [showAccountModal, pendingEmptyTrash, pendingEmptyUnifiedTrash, onBackToMain])

  const activeUnified = resolveActiveUnified()
  const activeSmart = resolveActiveSmart()
  const activeLabel = activeUnified?.label
    || (activeSmart ? `# ${activeSmart.name}` : null)
    || accounts.flatMap(account => (account.folders || []).map(folder => ({
      key: `${account.id}:${folder.id || folder.name}`,
      label: `${getAccountLabel(account)} / ${getMailFolderLabel(folder, mt)}`,
    }))).find(item => item.key === activeKey)?.label
    || mt.mail
  const activeFolder = resolveActiveFolder()
  const activeAccountId = activeFolder?.account?.id || accounts[0]?.id || ''
  const isActiveDraftFolder = activeFolder?.folder?.type === 'drafts' || activeUnified?.type === 'drafts'
  const contextMenuFolders = (accounts.find(account => account.id === messageMenu?.message?.account_id)?.folders || [])
  const selectedMessageIdSet = new Set(selectedMessageIds)

  // 목록/본문 내용은 한 번만 정의하고, 데스크톱(분할 리사이즈)·모바일(세로 스택) 양쪽에서 재사용한다.
  const mailListContent = (
    <>
      <div className="flex-shrink-0 border-b border-gray-100 p-3">
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
            <MenuIcon type="search" />
          </span>
          <input
            type="search"
            value={mailSearchQuery}
            onChange={event => {
              setMailSearchQuery(event.target.value)
              setLastSelectedMessageId(null)
            }}
            placeholder={mt.searchPlaceholder}
            className="h-10 w-full rounded-lg border border-gray-200 bg-gray-50 pl-10 pr-3 text-sm text-gray-700 outline-none transition focus:border-indigo-400 focus:bg-white focus:ring-2 focus:ring-indigo-100"
          />
        </div>
        <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
          <span className="font-bold">{mt.mailList}</span>
          {selectedMessageIds.length > 0 ? (
            <button
              type="button"
              onClick={clearMailSelection}
              className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-1 font-extrabold text-indigo-600 transition hover:bg-indigo-100"
              title={mt.clearSelection}
            >
              <span>{mt.selectedCount(selectedMessageIds.length)}</span>
              <span aria-hidden="true">×</span>
            </button>
          ) : (
            <span>{mt.count(displayedMessages.length)}</span>
          )}
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto"
        onClick={(event) => {
          if (event.currentTarget === event.target) clearMailSelection()
        }}
        onScroll={handleMessagesScroll}
      >
        <MailMessageList
          messages={displayedMessages}
          loading={messagesLoading}
          error={messagesError}
          label={activeLabel}
          selectedId={selectedMessage?.id}
          selectedIds={selectedMessageIdSet}
          onSelect={selectMessage}
          onDoubleClick={isActiveDraftFolder ? openDraftForEditing : undefined}
          onContextMenu={openMessageMenu}
          loadingMore={loadingMore}
          activeSmartFolderId={activeSmart?.id || null}
          mt={mt}
        />
      </div>
    </>
  )

  const mailBodyContent = composeMode ? (
    <MailComposeView
      key={composeDraft?.draftId || 'new-compose'}
      accounts={accounts}
      defaultAccountId={activeAccountId}
      initialDraft={composeDraft}
      onCancel={() => setComposeMode(false)}
      onSent={() => {
        setComposeMode(false)
        refreshMail()
      }}
      onDraftSaved={async (accountId, draft) => {
        setComposeMode(false)
        const nextAccounts = await reloadMailAccounts()
        const account = nextAccounts.find(item => item.id === accountId)
        const draftFolder = (account?.folders || []).find(folder => folder.id === draft?.folder_id || folder.type === 'drafts')
        if (draftFolder) {
          updateActiveKey(`${accountId}:${draftFolder.id || draftFolder.name}`)
        } else {
          await loadActiveMessages(nextAccounts, { silent: true, resetSelection: true })
        }
      }}
      mt={mt}
    />
  ) : (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <MailViewer
          message={selectedMessage}
          loading={messageDetailLoading}
          error={messageDetailError}
          onAddressSearch={setMailSearchQuery}
          onMailAction={startMailAction}
          onSummaryUpdated={(nextSummary) => {
            setSelectedMessage(prev => (
              prev?.id === selectedMessage?.id ? { ...prev, summary: nextSummary } : prev
            ))
          }}
          onCalendarEventOpen={onOpenCalendarEvent}
          targetLanguage={language || 'ko'}
          mt={mt}
        />
      </div>
    </div>
  )

  return (
    <div className="flex flex-col md:flex-row flex-1 min-h-0 min-w-0 overflow-hidden bg-gray-50">
      <aside
        className="w-full flex-shrink-0 bg-gray-200 flex flex-col h-auto md:h-full max-h-72 md:max-h-none border-b md:border-b-0 border-gray-100"
        style={isSidebarResizable ? { width: sidebarWidth } : undefined}
      >
        <div className="flex-1 overflow-y-auto py-2">
          <div className="px-3 pb-2 mb-1 border-b border-gray-300">
            <div className="flex items-center gap-2.5 px-2 py-2 text-gray-900">
              <MailIcon className="w-5 h-5 text-indigo-600" />
              <span className="font-extrabold">{mt.mail}</span>
            </div>
            <button
              type="button"
              onClick={openCompose}
              className="mb-2 flex w-full items-center gap-2.5 rounded-lg border border-indigo-100 bg-white px-4 py-3 text-left text-sm font-extrabold text-indigo-600 shadow-sm transition-all hover:border-indigo-200 hover:bg-indigo-50 hover:shadow-md"
            >
              <MenuIcon type="draft" />
              <span>{mt.compose}</span>
            </button>
            <button
              type="button"
              onClick={refreshMail}
              disabled={refreshLoading}
              className="mb-3 flex w-full items-center gap-2.5 rounded-lg border border-gray-300 bg-gray-100 px-4 py-2.5 text-left text-sm font-bold text-gray-600 transition-all hover:bg-white hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <MenuIcon type="refresh" />
              <span>{refreshLoading ? mt.syncing : mt.refresh}</span>
            </button>
            <div className="flex flex-col gap-1 mt-1">
              {unifiedMenus.map(item => {
                const key = `${UNIFIED_KEY_PREFIX}${item.key}`
                return (
                <MailMenuButton
                  key={item.key}
                  active={!composeMode && activeKey === key}
                  icon={item.icon}
                  label={item.label}
                  count={item.message_count}
                  unreadCount={item.unread_count}
                  iconColor={FOLDER_COLOR_MAP[item.color_key] || ''}
                  onClick={() => activateMailKey(key)}
                  onContextMenu={(event) => openUnifiedFolderMenu(event, item)}
                  onDragOver={(event) => handleUnifiedDragOver(event, item, key)}
                  onDragLeave={(event) => handleFolderDragLeave(event, key)}
                  onDrop={(event) => handleUnifiedDrop(event, item)}
                  dropActive={dropTargetKey === key}
                />
                )
              })}
            </div>

            {/* ② 스마트 폴더 구역 (태그 기반 통합 — MailService.md 13.2.1). 시스템 항목과 분리 표기. */}
            <div className="mt-4">
              <div className="mb-1 flex items-center justify-between px-2">
                <button
                  type="button"
                  onClick={toggleSmartSection}
                  title={mt.smartFolders}
                  className="flex select-none items-center gap-1 text-xs font-extrabold uppercase tracking-wide text-gray-400 transition-colors hover:text-gray-600"
                >
                  <span className={`transition-transform ${smartSectionCollapsed ? '-rotate-90' : ''}`}><MenuIcon type="chevronDown" /></span>
                  <span>{mt.smartFolders}</span>
                  {smartSectionCollapsed && smartFolders.length > 0 && (
                    <span className="ml-1 rounded-full bg-gray-100 px-1.5 text-[10px] font-bold text-gray-400">{smartFolders.length}</span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={createSmartFolderPrompt}
                  title={mt.addSmartFolder}
                  className="flex h-5 w-5 items-center justify-center rounded text-gray-400 transition-colors hover:bg-gray-100 hover:text-indigo-600"
                >
                  +
                </button>
              </div>
              {smartSectionCollapsed ? null : smartFolders.length === 0 ? (
                <p className="px-2 py-1 text-[11px] leading-4 text-gray-400">
                  {mt.smartFolderHint}
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  {smartFolders.map(folder => {
                    const key = `${SMART_KEY_PREFIX}${folder.id}`
                    return (
                      <MailMenuButton
                        key={folder.id}
                        active={!composeMode && activeKey === key}
                        icon="tag"
                        label={folder.name}
                        count={folder.message_count}
                        unreadCount={folder.unread_count}
                        iconColor={resolveTagColor(folder.color_key, folder.name)}
                        onClick={() => activateMailKey(key)}
                        onContextMenu={(event) => openSmartFolderMenu(event, folder)}
                        onDragOver={(event) => handleSmartDragOver(event, key)}
                        onDragLeave={(event) => handleFolderDragLeave(event, key)}
                        onDrop={(event) => handleSmartDrop(event, folder)}
                        dropActive={dropTargetKey === key}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="px-3 pb-2">
            <div className="flex flex-col gap-2 mt-1">
              {accounts.map(account => {
                const collapsed = collapsedAccountIds.has(account.id)
                const folders = Array.isArray(account.folders) && account.folders.length > 0
                  ? account.folders
                  : [
                      { id: 'inbox', name: mt.folders.inbox, type: 'inbox' },
                      { id: 'sent', name: mt.folders.sent, type: 'sent' },
                      { id: 'drafts', name: mt.folders.drafts, type: 'drafts' },
                    ]
                const visibleFolders = buildHierarchicalFolderList(folders, mt)
                return (
                  <div key={account.id}>
                    <button
                      type="button"
                      onClick={() => toggleAccount(account.id)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-bold text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
                      aria-expanded={!collapsed}
                    >
                      <MenuIcon type={collapsed ? 'chevronRight' : 'chevronDown'} />
                      <ProviderLogo provider={account.provider} host={account.imap_host} size="sm" />
                      <span className="truncate">{getAccountLabel(account)}</span>
                    </button>
                    {!collapsed && (
                      <div className="flex flex-col gap-0.5">
                        {visibleFolders.map(({ folder, depth }) => {
                          const key = `${account.id}:${folder.id || folder.name}`
                          const folderDepth = 1 + depth
                          const folderColor = FOLDER_COLOR_MAP[folder.color_key] || ''
                          return (
                            <MailMenuButton
                              key={key}
                              active={activeKey === key}
                              icon={folder.type === 'inbox' || folder.name === '받은 편지함' || folder.name === mt.folders.inbox ? 'inbox' : folder.type === 'trash' ? 'trash' : 'folder'}
                              label={getMailFolderLabel(folder, mt)}
                              title={getMailFolderTitle(folder, mt)}
                              count={folder.message_count}
                              unreadCount={folder.unread_count}
                              iconColor={folderColor}
                              depth={folderDepth}
                              onClick={() => activateMailKey(key)}
                              onContextMenu={(event) => openFolderMenu(event, account, folder)}
                              onDragOver={(event) => handleFolderDragOver(event, folder, key)}
                              onDragLeave={(event) => handleFolderDragLeave(event, key)}
                              onDrop={(event) => handleFolderDrop(event, folder)}
                              dropActive={dropTargetKey === key}
                            />
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
              {accounts.length === 0 && (
                <div className="rounded-lg border border-dashed border-gray-300 px-3 py-3 text-xs text-gray-500">
                  {mailMetaLoading
                    ? mt.metaLoading
                    : mailMetaError || mt.noAccounts}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex gap-2 border-t border-gray-100 px-3 py-2">
          <button
            type="button"
            onClick={onBackToMain}
            className="flex basis-3/4 items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm text-gray-500 transition-all hover:bg-gray-200 hover:text-gray-900"
          >
            <MenuIcon type="back" />
            <span className="font-medium">{mt.mainMenu}</span>
          </button>
          <button
            type="button"
            onClick={() => setShowAccountModal(true)}
            className="flex basis-1/4 items-center justify-center rounded-lg px-2 py-2 text-gray-500 transition-all hover:bg-gray-200 hover:text-gray-900"
            title={mt.accountSettings}
            aria-label={mt.accountSettings}
          >
            <MenuIcon type="settings" />
          </button>
        </div>
      </aside>

      {isSidebarResizable && (
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={startSidebarResize}
          title="드래그하여 사이드바 너비 조절"
          className="hidden md:block w-1.5 flex-shrink-0 cursor-col-resize bg-gray-200 transition-colors hover:bg-indigo-400 active:bg-indigo-500"
        />
      )}

      <main className="flex-1 min-w-0 overflow-hidden flex flex-col bg-gray-50">
        <section className="flex-1 min-h-0 overflow-hidden p-4 md:p-5">
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white lg:flex-row">
            {!composeMode && isDesktopSplit ? (
              // 데스크톱: 목록↔본문을 드래그로 리사이즈. autoSaveId로 위치를 localStorage에 영속화.
              <PanelGroup direction="horizontal" autoSaveId="mail-list-split" className="flex h-full min-h-0 w-full">
                <Panel defaultSize={28} minSize={18} maxSize={50} className="flex min-h-0 flex-col">
                  {mailListContent}
                </Panel>
                <PanelResizeHandle className="w-1.5 flex-shrink-0 cursor-col-resize bg-gray-200 transition-colors hover:bg-indigo-400 active:bg-indigo-500" />
                <Panel minSize={35} className="flex min-w-0 flex-col overflow-hidden">
                  {mailBodyContent}
                </Panel>
              </PanelGroup>
            ) : (
              // 모바일(<lg) 또는 쓰기 모드: 기존 세로 스택 / 본문 전체 폭 유지.
              <>
                {!composeMode && (
                  <div className="flex h-80 flex-shrink-0 flex-col border-b border-gray-200 lg:h-full lg:w-[360px] lg:border-b-0 lg:border-r">
                    {mailListContent}
                  </div>
                )}
                <div className="min-w-0 flex-1 overflow-hidden">
                  {mailBodyContent}
                </div>
              </>
            )}
          </div>
        </section>
      </main>
      {showAccountModal && (
        <MailAccountManageModal
          accounts={accounts}
          tenants={tenants}
          activeFolder={activeFolder}
          activeUnified={activeUnified}
          currentTenantId={currentTenantId}
          initialMailClawRegistration={mailClawRegistration}
          onClose={() => setShowAccountModal(false)}
          onAccountAdded={reloadMailAccounts}
          onMailDataChanged={async () => {
            const nextAccounts = await reloadMailAccounts()
            await loadActiveMessages(nextAccounts, { silent: true, resetSelection: false })
          }}
          mt={mt}
        />
      )}
      <MailMessageContextMenu
        menu={messageMenu}
        folders={contextMenuFolders}
        onClose={() => setMessageMenu(null)}
        onDelete={deleteMessage}
        onMarkUnread={markMessageUnread}
        onToggleStar={toggleMessagesStarred}
        onMove={moveMessage}
        onAgenticWatch={registerAgenticWatch}
        onRegisterMailClaw={registerMailClawFromMessage}
        onRegisterMailClawTrash={registerMailClawTrashFromMessage}
        mt={mt}
      />
      <FolderContextMenu
        menu={folderMenu}
        onClose={() => setFolderMenu(null)}
        onCreateFolder={(menu) => createMailFolder(menu)}
        onCreateSubFolder={(menu) => createMailFolder(menu, menu?.folder)}
        onRenameFolder={renameMailFolder}
        onDeleteFolder={deleteMailFolder}
        onSetFolderColor={setMailFolderColor}
        onEmptyTrash={setPendingEmptyTrash}
        mt={mt}
      />
      <UnifiedFolderContextMenu
        menu={unifiedFolderMenu}
        onClose={() => setUnifiedFolderMenu(null)}
        onRefresh={refreshMail}
        onSetFolderColor={setUnifiedFolderColor}
        onEmptyUnifiedTrash={(folder) => setPendingEmptyUnifiedTrash(folder || { key: 'trash' })}
        mt={mt}
      />
      <SmartFolderContextMenu
        menu={smartFolderMenu}
        onClose={() => setSmartFolderMenu(null)}
        onRename={renameSmartFolder}
        onDelete={deleteSmartFolder}
        onSetColor={setSmartFolderColor}
        mt={mt}
      />
      {pendingEmptyTrash && (
        <ConfirmDialog
          title={mt.dialogs.emptyTrashTitle}
          message={mt.dialogs.emptyTrashMessage}
          confirmText={mt.ok}
          cancelText={mt.cancel}
          danger
          onConfirm={() => emptyTrashFolder(pendingEmptyTrash)}
          onCancel={() => setPendingEmptyTrash(null)}
        />
      )}
      {pendingDeleteFolder && (
        <ConfirmDialog
          title={mt.folderMenu.delete}
          message={pendingDeleteFolder.message}
          confirmText={mt.ok}
          cancelText={mt.cancel}
          danger={pendingDeleteFolder.danger}
          onConfirm={() => performDeleteMailFolder(pendingDeleteFolder)}
          onCancel={() => setPendingDeleteFolder(null)}
        />
      )}
      {pendingEmptyUnifiedTrash && (
        <ConfirmDialog
          title={mt.dialogs.emptyUnifiedTrashTitle}
          message={mt.dialogs.emptyUnifiedTrashMessage(getUnifiedTrashTargets().length)}
          confirmText={mt.ok}
          cancelText={mt.cancel}
          danger
          onConfirm={emptyUnifiedTrash}
          onCancel={() => setPendingEmptyUnifiedTrash(null)}
        />
      )}
      {folderNameDialog && (
        <MailInputDialog
          title={folderNameDialog.title}
          message={folderNameDialog.message}
          initialValue={folderNameDialog.initialValue || ''}
          confirmText={mt.ok}
          cancelText={mt.cancel}
          loading={folderNameDialogLoading}
          onConfirm={confirmFolderNameDialog}
          onCancel={() => {
            if (!folderNameDialogLoading) setFolderNameDialog(null)
          }}
        />
      )}
    </div>
  )
}
