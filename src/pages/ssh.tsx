import React, { useState, useRef, useEffect } from 'react';
import {Server,Key,User,Lock,ArrowLeft,Wifi,WifiOff} from 'lucide-react';
import { invoke } from "@tauri-apps/api/core";

interface SSHConnectionConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  private_key_path?: string;
  passphrase?: string;
}

interface SSHConnectionResponse {
  success: boolean;
  message: string;
  connection_id?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exit_status: number;
  success: boolean;
}

interface TerminalHistoryItem {
  command: string;
  result: CommandResult;
  timestamp: Date;
}

const SSHInterface: React.FC = () => {
  const [currentView, setCurrentView] = useState<'connect' | 'terminal'>('connect');
  const [connectionId, setConnectionId] = useState<string | null>(null);
  // for not build
  //   const [isConnected, setIsConnected] = useState(false);
  const [_, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Connection form state
  const [authMethod, setAuthMethod] = useState<'password' | 'key'>('password');
  const [connectionConfig, setConnectionConfig] = useState<SSHConnectionConfig>({
    host: '',
    port: 22,
    username: '',
    password: '',
    private_key_path: '',
    passphrase: ''
  });

  // Terminal state
  const [currentCommand, setCurrentCommand] = useState('');
  const [terminalHistory, setTerminalHistory] = useState<TerminalHistoryItem[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll terminal to bottom
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [terminalHistory]);

  // Focus input when terminal is active
  useEffect(() => {
    if (currentView === 'terminal' && inputRef.current) {
      inputRef.current.focus();
    }
  }, [currentView]);

  const handleConnect = async () => {
    setIsLoading(true);

    try {
      const config: SSHConnectionConfig = {
        host: connectionConfig.host,
        port: connectionConfig.port,
        username: connectionConfig.username,
        ...(authMethod === 'password'
          ? { password: connectionConfig.password}
          : {
              private_key_path: connectionConfig.private_key_path,
              passphrase: connectionConfig.passphrase || undefined
            }
        )
      };

      const response: SSHConnectionResponse = await invoke('connect_ssh', { config });

      if (response.success && response.connection_id) {
        setConnectionId(response.connection_id);
        setIsConnected(true);
        setCurrentView('terminal');

        // Add welcome message to terminal
        setTerminalHistory([{
          command: 'connection_established',
          result: {
            stdout: `Connected to ${connectionConfig.username}@${connectionConfig.host}:${connectionConfig.port}\n${response.message}`,
            stderr: '',
            exit_status: 0,
            success: true
          },
          timestamp: new Date()
        }]);
      } else {
        alert(`Connection failed: ${response.message}`);
      }
    } catch (error) {
      alert(`Error: ${error}`);
    } finally {
      setIsLoading(false);
    }
  };

  const executeCommand = async (command: string) => {
    if (!connectionId || !command.trim()) return;

    setIsExecuting(true);

    try {
      const result: CommandResult = await invoke('execute_ssh_command', {
        connectionId,
        command: command.trim()
      });

      const historyItem: TerminalHistoryItem = {
        command: command.trim(),
        result,
        timestamp: new Date()
      };

      setTerminalHistory(prev => [...prev, historyItem]);
    } catch (error) {
      const errorResult: CommandResult = {
        stdout: '',
        stderr: `Error executing command: ${error}`,
        exit_status: -1,
        success: false
      };

      setTerminalHistory(prev => [...prev, {
        command: command.trim(),
        result: errorResult,
        timestamp: new Date()
      }]);
    } finally {
      setIsExecuting(false);
      setCurrentCommand('');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isExecuting) {
      executeCommand(currentCommand);
    }
  };

  const handleDisconnect = async () => {
    if (connectionId) {
      try {
        await invoke('disconnect_ssh', { connectionId });
      } catch (error) {
        console.error('Error disconnecting:', error);
      }
    }

    setConnectionId(null);
    setIsConnected(false);
    setCurrentView('connect');
    setTerminalHistory([]);
    setCurrentCommand('');
  };

  const renderConnectionForm = () => (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-md mx-auto">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-full mb-4">
            <Server className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold mb-2">SSH Connection</h1>
          <p className="text-gray-400">Connect to your remote server</p>
        </div>

        <div className="bg-gray-800 rounded-lg p-6 space-y-4">
          {/* Host */}
          <div>
            <label className="block text-sm font-medium mb-2">Host</label>
            <div className="relative">
              <Server className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={connectionConfig.host}
                onChange={(e) => setConnectionConfig(prev => ({ ...prev, host: e.target.value }))}
                className="w-full bg-gray-700 rounded-lg pl-10 pr-4 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                placeholder="192.168.1.100 or example.com"
              />
            </div>
          </div>

          {/* Port */}
          <div>
            <label className="block text-sm font-medium mb-2">Port</label>
            <input
              type="number"
              value={connectionConfig.port}
              onChange={(e) => setConnectionConfig(prev => ({ ...prev, port: parseInt(e.target.value) || 22 }))}
              className="w-full bg-gray-700 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              placeholder="22"
            />
          </div>

          {/* Username */}
          <div>
            <label className="block text-sm font-medium mb-2">Username</label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={connectionConfig.username}
                onChange={(e) => setConnectionConfig(prev => ({ ...prev, username: e.target.value }))}
                className="w-full bg-gray-700 rounded-lg pl-10 pr-4 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                placeholder="root"
              />
            </div>
          </div>

          {/* Authentication Method */}
          <div>
            <label className="block text-sm font-medium mb-2">Authentication Method</label>
            <div className="flex space-x-2">
              <button
                type="button"
                onClick={() => setAuthMethod('password')}
                className={`flex-1 py-2 px-4 rounded-lg flex items-center justify-center space-x-2 ${
                  authMethod === 'password'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                <Lock className="w-4 h-4" />
                <span>Password</span>
              </button>
              <button
                type="button"
                onClick={() => setAuthMethod('key')}
                className={`flex-1 py-2 px-4 rounded-lg flex items-center justify-center space-x-2 ${
                  authMethod === 'key'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                <Key className="w-4 h-4" />
                <span>SSH Key</span>
              </button>
            </div>
          </div>

          {/* Authentication Fields */}
          {authMethod === 'password' ? (
            <div>
              <label className="block text-sm font-medium mb-2">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="password"
                  value={connectionConfig.password}
                  onChange={(e) => setConnectionConfig(prev => ({ ...prev, password: e.target.value }))}
                  className="w-full bg-gray-700 rounded-lg pl-10 pr-4 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  placeholder="Enter password"
                />
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium mb-2">Private Key Path</label>
                <div className="relative">
                  <Key className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    value={connectionConfig.private_key_path}
                    onChange={(e) => setConnectionConfig(prev => ({ ...prev, private_key_path: e.target.value }))}
                    className="w-full bg-gray-700 rounded-lg pl-10 pr-4 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    placeholder="~/.ssh/id_rsa"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Passphrase (Optional)</label>
                <input
                  type="password"
                  value={connectionConfig.passphrase}
                  onChange={(e) => setConnectionConfig(prev => ({ ...prev, passphrase: e.target.value }))}
                  className="w-full bg-gray-700 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  placeholder="Enter passphrase if required"
                />
              </div>
            </>
          )}

          {/* Connect Button */}
          <button
            onClick={handleConnect}
            disabled={isLoading || !connectionConfig.host || !connectionConfig.username}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg py-3 flex items-center justify-center space-x-2 font-medium transition-colors"
          >
            {isLoading ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                <span>Connecting...</span>
              </>
            ) : (
              <>
                <Wifi className="w-4 h-4" />
                <span>Connect</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );

  const renderTerminal = () => (
    <div className="min-h-screen bg-black text-green-400 font-mono">
      {/* Header */}
      <div className="bg-gray-900 border-b border-gray-700 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <button
            onClick={handleDisconnect}
            className="flex items-center space-x-2 text-gray-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back</span>
          </button>
          <div className="flex items-center space-x-2">
            <div className="w-2 h-2 bg-green-500 rounded-full" />
            <span className="text-sm">
              {connectionConfig.username}@{connectionConfig.host}:{connectionConfig.port}
            </span>
          </div>
        </div>
        <button
          onClick={handleDisconnect}
          className="flex items-center space-x-2 text-red-400 hover:text-red-300 transition-colors"
        >
          <WifiOff className="w-4 h-4" />
          <span>Disconnect</span>
        </button>
      </div>

      {/* Terminal Content */}
      <div className="h-screen overflow-hidden flex flex-col">
        <div
          ref={terminalRef}
          className="flex-1 overflow-y-auto p-4 space-y-2"
        >
          {terminalHistory.map((item, index) => (
            <div key={index} className="space-y-1">
              {item.command !== 'connection_established' && (
                <div className="flex items-center space-x-2">
                  <span className="text-blue-400">$</span>
                  <span className="text-white">{item.command}</span>
                </div>
              )}
              {item.result.stdout && (
                <pre className="text-green-400 whitespace-pre-wrap pl-4">
                  {item.result.stdout}
                </pre>
              )}
              {item.result.stderr && (
                <pre className="text-red-400 whitespace-pre-wrap pl-4">
                  {item.result.stderr}
                </pre>
              )}
            </div>
          ))}

          {/* Current command input */}
          <div className="flex items-center space-x-2">
            <span className="text-blue-400">$</span>
            <input
              ref={inputRef}
              type="text"
              value={currentCommand}
              onChange={(e) => setCurrentCommand(e.target.value)}
              onKeyPress={handleKeyPress}
              disabled={isExecuting}
              className="flex-1 bg-transparent text-white outline-none"
              placeholder={isExecuting ? "Executing..." : "Enter command..."}
            />
            {isExecuting && (
              <div className="w-4 h-4 border border-green-400 border-t-transparent rounded-full animate-spin" />
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return currentView === 'connect' ? renderConnectionForm() : renderTerminal();
};

export default SSHInterface;
