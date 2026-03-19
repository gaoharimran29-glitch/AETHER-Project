// src/hooks/useWebSocket.js
// DELETED — backend has no /ws endpoint.
// AetherWebSocket was removed from aetherApi.js.
// All real-time updates use HTTP polling via fetchSnapshot() in components.
// This file is kept as an empty export to avoid import errors if referenced.
export const useWebSocket = () => ({ isConnected: false, lastMessage: null, sendMessage: () => {} });