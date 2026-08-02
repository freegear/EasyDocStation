import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

const MeetingRecordingContext = createContext(null)

const defaultState = {
  meetingId: null,
  postId: null,
  title: '회의 녹음',
  isRecording: false,
  isPaused: false,
  status: '대기 중',
  elapsedMs: 0,
  download: null,
  error: null,
  pendingChunks: 0,
}

export function MeetingRecordingProvider({ children }) {
  const [state, setState] = useState(defaultState)
  const controlsRef = useRef({})

  const setRecordingState = useCallback((patch) => {
    setState((prev) => ({ ...prev, ...patch }))
  }, [])

  const startRecording = useCallback((payload = {}) => {
    setState((prev) => ({
      ...prev,
      ...payload,
      isRecording: true,
      isPaused: false,
      error: null,
      status: payload.status || '녹음 중',
      elapsedMs: Number(payload.elapsedMs || 0),
    }))
  }, [])

  const pauseRecording = useCallback(() => {
    setState((prev) => ({
      ...prev,
      isPaused: !prev.isPaused,
      isRecording: !prev.isPaused ? true : prev.isRecording,
      status: prev.isPaused ? '녹음 중' : '일시정지',
    }))
  }, [])

  const stopRecording = useCallback((payload = {}) => {
    setState((prev) => ({
      ...prev,
      ...payload,
      isRecording: false,
      isPaused: false,
      status: payload.status || '처리 중',
    }))
  }, [])

  const clearRecording = useCallback(() => {
    setState(defaultState)
  }, [])

  const setMeetingDownload = useCallback((download) => {
    setState((prev) => ({ ...prev, download }))
  }, [])

  const registerControls = useCallback((controls = {}) => {
    controlsRef.current = controls
  }, [])

  const invokeControl = useCallback((name, ...args) => {
    return controlsRef.current?.[name]?.(...args)
  }, [])

  const value = useMemo(() => ({
    ...state,
    setRecordingState,
    startRecording,
    pauseRecording,
    stopRecording,
    clearRecording,
    setMeetingDownload,
    registerControls,
    invokeControl,
  }), [state, setRecordingState, startRecording, pauseRecording, stopRecording, clearRecording, setMeetingDownload, registerControls, invokeControl])

  return (
    <MeetingRecordingContext.Provider value={value}>{children}</MeetingRecordingContext.Provider>
  )
}

export function useMeetingRecording() {
  const ctx = useContext(MeetingRecordingContext)
  if (!ctx) throw new Error('useMeetingRecording must be used within MeetingRecordingProvider')
  return ctx
}
