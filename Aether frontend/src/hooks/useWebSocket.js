// useWebSocket.js - React hook for WebSocket management
import { useEffect, useRef, useState, useCallback } from 'react';
import { AetherWebSocket } from '../api/aetherApi';

export const useWebSocket = () => {
  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState(null);
  const wsRef = useRef(null);

  useEffect(() => {
    const handleMessage = (data) => {
      setLastMessage(data);
    };

    const handleError = (error) => {
      console.error('WebSocket error in hook:', error);
    };

    const handleClose = () => {
      setIsConnected(false);
    };

    wsRef.current = new AetherWebSocket(handleMessage, handleError, handleClose);
    wsRef.current.connect();
    setIsConnected(true);

    return () => {
      if (wsRef.current) {
        wsRef.current.disconnect();
      }
    };
  }, []);

  const sendMessage = useCallback((data) => {
    if (wsRef.current) {
      wsRef.current.send(data);
    }
  }, []);

  return {
    isConnected,
    lastMessage,
    sendMessage
  };
};