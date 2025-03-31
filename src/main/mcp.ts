import path from 'path';
import fs from 'node:fs';
import { app } from 'electron';
import { IMCPConfig, IMCPServer } from 'types/mcp';
import { clone, cloneDeep, isUndefined, omitBy } from 'lodash';
import * as logging from './logging';

export const DEFAULT_INHERITED_ENV_VARS =
  process.platform === 'win32'
    ? [
        'APPDATA',
        'HOMEDRIVE',
        'HOMEPATH',
        'LOCALAPPDATA',
        'PATH',
        'PROCESSOR_ARCHITECTURE',
        'SYSTEMDRIVE',
        'SYSTEMROOT',
        'TEMP',
        'USERNAME',
        'USERPROFILE',
      ]
    : /* list inspired by the default env inheritance of sudo */
      ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];
/**
 * Returns a default environment object including only environment variables deemed safe to inherit.
 */
export function getDefaultEnvironment() {
  const env: Record<string, string> = {};
  DEFAULT_INHERITED_ENV_VARS.forEach((key) => {
    const value = process.env[key];
    if (value === undefined) {
      return;
    }
    if (value.startsWith('()')) {
      // Skip functions, which are a security risk.
      return;
    }
    env[key] = value;
  });
  return env;
}

export default class ModuleContext {
  private clients: { [key: string]: any } = {};

  private Client: any;

  private Transport: any;

  private cfgPath: string;

  constructor() {
    this.cfgPath = path.join(app.getPath('userData'), 'mcp.json');
  }

  public async init() {
    this.Client = await this.importClient();
    this.Transport = await this.importTransport();
  }

  private async importClient() {
    const { Client } = await import(
      '@modelcontextprotocol/sdk/client/index.js'
    );
    return Client;
  }

  private async importTransport() {
    const { StdioClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/stdio.js'
    );
    return StdioClientTransport;
  }

  private getMCPServer(server: IMCPServer, config: IMCPConfig) {
    let mcpSvr = config.servers.find(
      (svr: IMCPServer) => svr.key === server.key,
    );
    mcpSvr = {
      ...mcpSvr,
      ...omitBy({ ...server, isActive: true }, isUndefined),
    } as IMCPServer;
    logging.debug('MCP Server:', mcpSvr);
    return mcpSvr;
  }

  private async updateConfigAfterActivation(
    server: IMCPServer,
    config: IMCPConfig,
  ) {
    const index = config.servers.findIndex(
      (svr: IMCPServer) => svr.key === server.key,
    );
    if (index > -1) {
      config.servers[index] = server;
    } else {
      config.servers.push(server);
    }
    await this.putConfig(config);
  }

  private async updateConfigAfterDeactivation(key: string, config: IMCPConfig) {
    config.servers = config.servers.map((svr: IMCPServer) => {
      if (svr.key === key) {
        svr.isActive = false;
      }
      return svr;
    });
    await this.putConfig(config);
  }

  public async getConfig() {
    const defaultConfig = { servers: [] };
    try {
      if (!fs.existsSync(this.cfgPath)) {
        fs.writeFileSync(this.cfgPath, JSON.stringify(defaultConfig, null, 2));
      }
      const config = JSON.parse(fs.readFileSync(this.cfgPath, 'utf-8'));
      if (!config.servers) {
        config.servers = [];
      }
      return config;
    } catch (err: any) {
      logging.captureException(err);
      return defaultConfig;
    }
  }

  public async putConfig(config: any) {
    try {
      fs.writeFileSync(this.cfgPath, JSON.stringify(config, null, 2));
      return true;
    } catch (err: any) {
      logging.captureException(err);
      return false;
    }
  }

  public async load() {
    const { servers } = await this.getConfig();
    await Promise.all(servers.map(async (server: IMCPServer) => {
      if (server.isActive) {
        logging.debug('Activating server:', server.key);
        const { error } = await this.activate(server);
        if (error) {
          logging.error('Failed to activate server:', server.key, error);
        }
      }
    }));
  }

  public async addServer(server: IMCPServer) {
    const config = await this.getConfig();
    if (!config.servers.find((svr: IMCPServer) => svr.key === server.key)) {
      config.servers.push(server);
      await this.putConfig(config);
      return true;
    }
    return false;
  }

  public async updateServer(server: IMCPServer) {
    const config = await this.getConfig();
    const index = config.servers.findIndex(
      (svr: IMCPServer) => svr.key === server.key,
    );
    if (index > -1) {
      config.servers[index] = server;
      await this.putConfig(config);
      return true;
    }
    return false;
  }

  public async activate(server: IMCPServer): Promise<{ error: any }> {
    try {
      const config = await this.getConfig();
      const mcpSvr = this.getMCPServer(server, config) as IMCPServer;

      const { key, command, args, env } = mcpSvr;
      let cmd: string = command;
      let cmdArgs: string[] = cloneDeep(args)
      if (command === 'npx') {
        if (process.platform === 'win32') {
          cmd = 'cmd';
          cmdArgs.unshift('npx');
          cmdArgs.unshift('/c')
        } else {
          cmd = command;
        }
      }
      const mergedEnv = {
        ...getDefaultEnvironment(),
        ...env,
        PATH: process.env.PATH,
      };
      const client = new this.Client(
        {
          name: key,
          version: '1.0.0',
        },
        {
          capabilities: {},
        },
      );
      const transport = new this.Transport({
        command: cmd,
        args: cmdArgs,
        stderr: process.platform === 'win32' ? 'pipe' : 'inherit',
        env: mergedEnv,
      });
      // await client.connect(transport, { timeout: 60 * 1000 * 5 }); not yet
      await client.connect(transport);
      this.clients[key] = client;
      await this.updateConfigAfterActivation(mcpSvr, config);
      return { error: null };
    } catch (error: any) {
      logging.captureException(error);
      this.deactivate(server.key);
      return { error };
    }
  }

  public async deactivate(key: string) {
    try {
      if (this.clients[key]) {
        await this.clients[key].close();
        delete this.clients[key];
      }
      await this.updateConfigAfterDeactivation(key, await this.getConfig());
      return { error: null };
    } catch (error: any) {
      logging.captureException(error);
      return { error };
    }
  }

  public async close() {
    await Promise.all(
      Object.keys(this.clients).map(async (key) => {
        logging.info(`Closing MCP Client ${key}`);
        await this.clients[key].close();
        delete this.clients[key];
      }),
    );
  }

  public async listTools(key?: string) {
    let allTools: any = [];
    if (key) {
      if (!this.clients[key]) {
        throw new Error(`MCP Client ${key} not found`);
      }
      const { tools } = await this.clients[key].listTools();
      allTools = tools.map((tool: any) => {
        tool.name = `${key}--${tool.name}`;
        return tool;
      });
    } else {
      await Promise.all(Object.keys(this.clients).map(async (clientName:string) => {
        const { tools } = await this.clients[clientName].listTools();
        allTools = allTools.concat(
          tools.map((tool: any) => {
            tool.name = `${clientName}--${tool.name}`;
            return tool;
          }),
        );
      }));
    }
    // logging.debug('All Tools:', JSON.stringify(allTools, null, 2));
    return allTools;
  }

  public async callTool({
    client,
    name,
    args,
  }: {
    client: string;
    name: string;
    args: any;
  }) {
    if (!this.clients[client]) {
      throw new Error(`MCP Client ${client} not found`);
    }
    logging.debug('Calling:', client, name, args);
    const result = await this.clients[client].callTool(
      {
        name,
        arguments: args,
      },
      undefined,
      { timeout: 60 * 1000 * 5 },
    );
    return result;
  }

  public getClient(name: string) {
    return this.clients[name];
  }

  public getClientNames() {
    return Object.keys(this.clients);
  }
}
