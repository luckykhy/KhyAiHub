import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useCrossPlatform } from '@/services/crossPlatform/crossPlatformClient';
import { notifyError } from '@/api/notify';

export const useCrossPlatformStore = defineStore('crossPlatform', () => {
  const cp = useCrossPlatform();
  
  const isInitialized = ref(false);
  const autoConnectAttempted = ref(false);

  // State passthrough — hand the client's refs/computeds to pinia DIRECTLY.
  // Wrapping them in `computed(() => cp.x)` returned the inner ref object as the
  // computed's value (computed getters do not unwrap refs), which made every
  // getter here permanently truthy/stale. Pinia's setup-store unwraps refs on
  // the returned object, so consumers still get plain reactive values.
  const {
    isConnected,
    isConnecting,
    connectionState,
    deviceId,
    userId,
    onlineDevices,
    terminalDevices,
    webDevices,
    desktopDevices,
    mobileDevices,
    sessionStates,
    notifications,
    unreadNotifications,
    lastError,
  } = cp;

  // Actions
  function init() {
    if (isInitialized.value) return;
    isInitialized.value = true;
    
    // Auto-connect if we have a backend URL
    autoConnect();
  }

  async function autoConnect() {
    if (autoConnectAttempted.value) return;
    autoConnectAttempted.value = true;

    try {
      // Try to connect - the URL will be discovered from runtime config
      await cp.connect();
    } catch (err) {
      // Auto-connect failure is non-blocking
      console.warn('[CrossPlatform] Auto-connect failed:', err?.message);
    }
  }

  async function connect(url) {
    try {
      await cp.connect(url);
    } catch (err) {
      notifyError(err);
      throw err;
    }
  }

  function disconnect() {
    cp.disconnect();
  }

  function joinSession(sessionId) {
    cp.joinSession(sessionId);
  }

  function leaveSession(sessionId) {
    cp.leaveSession(sessionId);
  }

  function updateSession(sessionId, delta) {
    cp.updateSession(sessionId, delta);
  }

  function sendMessage(target) {
    cp.sendMessage(target);
  }

  function routeCommand(targetPlatform, command, payload) {
    cp.routeCommand(targetPlatform, command, payload);
  }

  function listDevices() {
    cp.listDevices();
  }

  function handoffSession(sessionId, targetDeviceId, targetPlatform) {
    cp.handoffSession(sessionId, targetDeviceId, targetPlatform);
  }

  function acceptHandoff(sessionId) {
    cp.acceptHandoff(sessionId);
  }

  function markNotificationRead(id) {
    cp.markNotificationRead(id);
  }

  function clearNotifications() {
    cp.clearNotifications();
  }

  return {
    // State
    isInitialized,
    autoConnectAttempted,
    // Computed
    isConnected,
    isConnecting,
    connectionState,
    deviceId,
    userId,
    onlineDevices,
    terminalDevices,
    webDevices,
    desktopDevices,
    mobileDevices,
    sessionStates,
    notifications,
    unreadNotifications,
    lastError,
    // Actions
    init,
    autoConnect,
    connect,
    disconnect,
    joinSession,
    leaveSession,
    updateSession,
    sendMessage,
    routeCommand,
    listDevices,
    handoffSession,
    acceptHandoff,
    markNotificationRead,
    clearNotifications,
  };
});
