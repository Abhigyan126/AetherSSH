// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use ssh2::Session;
use std::io::prelude::*;
use std::net::TcpStream;
use std::path::Path;
use anyhow::{Result, Context};
use std::net::ToSocketAddrs;
use serde::{Deserialize, Serialize};
use tauri::State;
use std::sync::{Arc, Mutex};
use std::collections::HashMap;

#[derive(Debug, Deserialize)]
pub struct SSHConnectionConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SSHConnectionResponse {
    pub success: bool,
    pub message: String,
    pub connection_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_status: i32,
    pub success: bool,
    pub current_directory: String,
}

struct SSHClient {
    session: Session,
    current_directory: String,
}

impl SSHClient {
    pub fn new(host: &str, port: u16) -> Result<Self> {
        let addr = (host, port).to_socket_addrs()?.find(|a| a.is_ipv4())
            .context("Failed to resolve IPv4 address")?;

        let tcp = TcpStream::connect(addr)
            .context("Failed to establish TCP connection")?;

        let mut session = Session::new()?;
        session.set_tcp_stream(tcp);
        session.handshake()?;

        Ok(SSHClient {
            session,
            current_directory: String::new(), // Will be set after authentication
        })
    }

    pub fn authenticate_with_password(&mut self, username: &str, password: &str) -> Result<()> {
        self.session.userauth_password(username, password)
            .context("Password authentication failed")?;

        // Get initial working directory
        self.update_current_directory()?;
        Ok(())
    }

    pub fn authenticate_with_key(&mut self, username: &str, private_key_path: &str, passphrase: Option<&str>) -> Result<()> {
        self.session.userauth_pubkey_file(
            username,
            None,
            Path::new(private_key_path),
            passphrase,
        ).context("Key authentication failed")?;

        // Get initial working directory
        self.update_current_directory()?;
        Ok(())
    }

    fn update_current_directory(&mut self) -> Result<()> {
        let mut channel = self.session.channel_session()?;
        channel.exec("pwd")?;

        let mut stdout = String::new();
        channel.read_to_string(&mut stdout)?;
        channel.wait_close()?;

        self.current_directory = stdout.trim().to_string();
        Ok(())
    }

    fn is_directory_change_command(&self, command: &str) -> bool {
        let trimmed = command.trim();
        trimmed.starts_with("cd ") || trimmed == "cd"
    }

    pub fn execute_command(&mut self, command: &str) -> Result<CommandResult> {
        let is_cd_command = self.is_directory_change_command(command);

        // For cd commands, we need to handle them specially
        let full_command = if is_cd_command {
            // Execute cd command and then pwd to get new directory
            format!("cd {} && pwd", &command[2..].trim()) // Remove "cd" and trim
        } else {
            // For other commands, execute them in the current directory context
            if self.current_directory.is_empty() {
                command.to_string()
            } else {
                format!("cd '{}' && {}", self.current_directory, command)
            }
        };

        let mut channel = self.session.channel_session()?;
        channel.request_pty("xterm", None, None)?;
        channel.exec(&full_command)?;

        let mut stdout = String::new();
        channel.read_to_string(&mut stdout)?;

        let mut stderr = String::new();
        channel.stderr().read_to_string(&mut stderr)?;

        channel.wait_close()?;
        let exit_status = channel.exit_status()?;

        // If it was a successful cd command, update our current directory
        if is_cd_command && exit_status == 0 {
            self.current_directory = stdout.trim().to_string();
            // For cd commands, we don't want to show the pwd output
            Ok(CommandResult {
                stdout: String::new(),
                stderr,
                exit_status,
                success: exit_status == 0,
                current_directory: self.current_directory.clone(),
            })
        } else {
            Ok(CommandResult {
                stdout,
                stderr,
                exit_status,
                success: exit_status == 0,
                current_directory: self.current_directory.clone(),
            })
        }
    }

    pub fn get_current_directory(&self) -> &str {
        &self.current_directory
    }
}

// Type alias for the connections store
type ConnectionsStore = Arc<Mutex<HashMap<String, SSHClient>>>;

#[tauri::command]
async fn connect_ssh(
    config: SSHConnectionConfig,
    connections: State<'_, ConnectionsStore>,
) -> Result<SSHConnectionResponse, String> {
    // Generate a unique connection ID
    let connection_id = format!("{}@{}:{}", config.username, config.host, config.port);

    // Create SSH client
    let mut client = match SSHClient::new(&config.host, config.port) {
        Ok(client) => client,
        Err(e) => {
            return Ok(SSHConnectionResponse {
                success: false,
                message: format!("Failed to create SSH connection: {}", e),
                connection_id: None,
            });
        }
    };

    // Authenticate based on provided credentials
    let auth_result = if let Some(password) = &config.password {
        // Password authentication
        client.authenticate_with_password(&config.username, password)
    } else if let Some(private_key_path) = &config.private_key_path {
        // Key authentication
        client.authenticate_with_key(
            &config.username,
            private_key_path,
            config.passphrase.as_deref(),
        )
    } else {
        return Ok(SSHConnectionResponse {
            success: false,
            message: "No authentication method provided (password or private_key_path required)".to_string(),
            connection_id: None,
        });
    };

    match auth_result {
        Ok(_) => {
            // Store the connection
            let mut connections = connections.lock().map_err(|e| format!("Lock error: {}", e))?;
            connections.insert(connection_id.clone(), client);

            Ok(SSHConnectionResponse {
                success: true,
                message: "Successfully connected and authenticated".to_string(),
                connection_id: Some(connection_id),
            })
        }
        Err(e) => Ok(SSHConnectionResponse {
            success: false,
            message: format!("Authentication failed: {}", e),
            connection_id: None,
        }),
    }
}

#[tauri::command]
async fn execute_ssh_command(
    connection_id: String,
    command: String,
    connections: State<'_, ConnectionsStore>,
) -> Result<CommandResult, String> {
    let mut connections = connections.lock().map_err(|e| format!("Lock error: {}", e))?;

    let client = connections.get_mut(&connection_id)
        .ok_or_else(|| "Connection not found. Please connect first.".to_string())?;

    match client.execute_command(&command) {
        Ok(result) => Ok(result),
        Err(e) => Ok(CommandResult {
            stdout: String::new(),
            stderr: format!("Command execution failed: {}", e),
            exit_status: -1,
            success: false,
            current_directory: client.get_current_directory().to_string(),
        }),
    }
}

// New command to get current directory
#[tauri::command]
async fn get_current_directory(
    connection_id: String,
    connections: State<'_, ConnectionsStore>,
) -> Result<String, String> {
    let connections = connections.lock().map_err(|e| format!("Lock error: {}", e))?;

    let client = connections.get(&connection_id)
        .ok_or_else(|| "Connection not found. Please connect first.".to_string())?;

    Ok(client.get_current_directory().to_string())
}

// Optional: Command to disconnect and cleanup
#[tauri::command]
async fn disconnect_ssh(
    connection_id: String,
    connections: State<'_, ConnectionsStore>,
) -> Result<bool, String> {
    let mut connections = connections.lock().map_err(|e| format!("Lock error: {}", e))?;

    match connections.remove(&connection_id) {
        Some(_) => Ok(true),
        None => Ok(false),
    }
}

// Optional: Command to list active connections
#[tauri::command]
async fn list_ssh_connections(
    connections: State<'_, ConnectionsStore>,
) -> Result<Vec<String>, String> {
    let connections = connections.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok(connections.keys().cloned().collect())
}

// Setup function for Tauri app
fn setup_ssh_commands() -> ConnectionsStore {
    Arc::new(Mutex::new(HashMap::new()))
}

fn main() {
    tauri::Builder::default()
        .manage(setup_ssh_commands())
        .invoke_handler(tauri::generate_handler![
            connect_ssh,
            execute_ssh_command,
            disconnect_ssh,
            list_ssh_connections,
            get_current_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
