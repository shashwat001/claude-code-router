import fs from "node:fs/promises";
import { execSync } from "child_process";
import path from "node:path";
import { CONFIG_FILE, HOME_DIR } from "../constants";
import JSON5 from "json5";

export interface StatusLineModuleConfig {
  type: string;
  icon?: string;
  text: string;
  color?: string;
  background?: string;
  scriptPath?: string; // For script type modules, specifies the Node.js script file path to execute
}

export interface StatusLineThemeConfig {
  modules: StatusLineModuleConfig[];
}

export interface StatusLineInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  model: {
    id: string;
    display_name: string;
  };
  workspace: {
    current_dir: string;
    project_dir: string;
  };
  version?: string;
  output_style?: {
    name: string;
  };
  cost?: {
    total_cost_usd: number;
    total_duration_ms: number;
    total_api_duration_ms: number;
    total_lines_added: number;
    total_lines_removed: number;
  };
  exceeds_200k_tokens?: boolean;
}

export interface AssistantMessage {
  type: "assistant";
  message: {
    model: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
    };
  };
}

// ANSI Color codes
const COLORS: Record<string, string> = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  // Standard colors
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  // Bright colors
  bright_black: "\x1b[90m",
  bright_red: "\x1b[91m",
  bright_green: "\x1b[92m",
  bright_yellow: "\x1b[93m",
  bright_blue: "\x1b[94m",
  bright_magenta: "\x1b[95m",
  bright_cyan: "\x1b[96m",
  bright_white: "\x1b[97m",
  // Background colors
  bg_black: "\x1b[40m",
  bg_red: "\x1b[41m",
  bg_green: "\x1b[42m",
  bg_yellow: "\x1b[43m",
  bg_blue: "\x1b[44m",
  bg_magenta: "\x1b[45m",
  bg_cyan: "\x1b[46m",
  bg_white: "\x1b[47m",
  // Bright background colors
  bg_bright_black: "\x1b[100m",
  bg_bright_red: "\x1b[101m",
  bg_bright_green: "\x1b[102m",
  bg_bright_yellow: "\x1b[103m",
  bg_bright_blue: "\x1b[104m",
  bg_bright_magenta: "\x1b[105m",
  bg_bright_cyan: "\x1b[106m",
  bg_bright_white: "\x1b[107m",
};

// Use TrueColor (24-bit) support for hexadecimal colors
const TRUE_COLOR_PREFIX = "\x1b[38;2;";
const TRUE_COLOR_BG_PREFIX = "\x1b[48;2;";

// Convert hexadecimal color to RGB format
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  // Remove # and spaces
  hex = hex.replace(/^#/, '').trim();
  
  // Handle shorthand form (#RGB -> #RRGGBB)
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  
  if (hex.length !== 6) {
    return null;
  }
  
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  
  // Validate if RGB values are valid
  if (isNaN(r) || isNaN(g) || isNaN(b) || r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) {
    return null;
  }
  
  return { r, g, b };
}

// Get color code
function getColorCode(colorName: string): string {
  // Check if it's a hexadecimal color
  if (colorName.startsWith('#') || /^[0-9a-fA-F]{6}$/.test(colorName) || /^[0-9a-fA-F]{3}$/.test(colorName)) {
    const rgb = hexToRgb(colorName);
    if (rgb) {
      return `${TRUE_COLOR_PREFIX}${rgb.r};${rgb.g};${rgb.b}m`;
    }
  }
  
  // Check if it's a predefined color
  if (COLORS[colorName]) {
    return COLORS[colorName];
  }
  
  // Return empty string by default
  return "";
}


// Variable replacement function, supports {{var}} format variable replacement
function replaceVariables(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_match, varName) => {
    return variables[varName] || "";
  });
}

// Execute script and get output
async function executeScript(scriptPath: string, variables: Record<string, string>): Promise<string> {
  try {
    // Check if file exists
    await fs.access(scriptPath);
    
    // Use require to dynamically load script module
    const scriptModule = require(scriptPath);
    
    // If exported is a function, call it and pass variables
    if (typeof scriptModule === 'function') {
      const result = scriptModule(variables);
      // If returned is a Promise, wait for it to complete
      if (result instanceof Promise) {
        return await result;
      }
      return result;
    }
    
    // If exported is a default function, call it
    if (scriptModule.default && typeof scriptModule.default === 'function') {
      const result = scriptModule.default(variables);
      // If returned is a Promise, wait for it to complete
      if (result instanceof Promise) {
        return await result;
      }
      return result;
    }
    
    // If exported is a string, return it directly
    if (typeof scriptModule === 'string') {
      return scriptModule;
    }
    
    // If exported is a default string, return it
    if (scriptModule.default && typeof scriptModule.default === 'string') {
      return scriptModule.default;
    }
    
    // Return empty string by default
    return "";
  } catch (error) {
    console.error(`Error executing script ${scriptPath}:`, error);
    return "";
  }
}

// Default theme configuration - uses Nerd Fonts icons and beautiful colors
const DEFAULT_THEME: StatusLineThemeConfig = {
  modules: [
    {
      type: "workDir",
      icon: "󰉋", // nf-md-folder_outline
      text: "{{workDirName}}",
      color: "bright_blue"
    },
    {
      type: "gitBranch",
      icon: "", // nf-dev-git_branch
      text: "{{gitBranch}}",
      color: "bright_magenta"
    },
    {
      type: "model",
      icon: "󰚩", // nf-md-robot_outline
      text: "{{model}}",
      color: "bright_cyan"
    },
    {
      type: "usage",
      icon: "↑", // 上箭头
      text: "{{inputTokens}}",
      color: "bright_green"
    },
    {
      type: "usage",
      icon: "↓", // 下箭头
      text: "{{outputTokens}}",
      color: "bright_yellow"
    }
  ]
};

// Powerline style theme configuration
const POWERLINE_THEME: StatusLineThemeConfig = {
  modules: [
    {
      type: "workDir",
      icon: "󰉋", // nf-md-folder_outline
      text: "{{workDirName}}",
      color: "white",
      background: "bg_bright_blue"
    },
    {
      type: "gitBranch",
      icon: "", // nf-dev-git_branch
      text: "{{gitBranch}}",
      color: "white",
      background: "bg_bright_magenta"
    },
    {
      type: "model",
      icon: "󰚩", // nf-md-robot_outline
      text: "{{model}}",
      color: "white",
      background: "bg_bright_cyan"
    },
    {
      type: "usage",
      icon: "↑", // 上箭头
      text: "{{inputTokens}}",
      color: "white",
      background: "bg_bright_green"
    },
    {
      type: "usage",
      icon: "↓", // 下箭头
      text: "{{outputTokens}}",
      color: "white",
      background: "bg_bright_yellow"
    }
  ]
};

// Simple text theme configuration - fallback for when icons cannot be displayed
const SIMPLE_THEME: StatusLineThemeConfig = {
  modules: [
    {
      type: "model",
      icon: "",
      text: "{{model}}",
      color: "bright_cyan"
    },
    {
      type: "workDir",
      icon: "",
      text: "{{workDirName}}",
      color: "bright_blue"
    },
    {
      type: "totalTokens",
      icon: "Tokens:",
      text: "{{totalTokens}}",
      color: "bright_white"
    },
    {
      type: "usage",
      icon: "↑",
      text: "{{inputTokens}}",
      color: "bright_green"
    },
    {
      type: "usage",
      icon: "→",
      text: "{{outputTokens}}",
      color: "bright_yellow"
    }
  ]
};

// Format usage information, use k unit if greater than 1000
function formatUsage(input_tokens: number, output_tokens: number): string {
  if (input_tokens > 1000 || output_tokens > 1000) {
    const inputFormatted = input_tokens > 1000 ? `${(input_tokens / 1000).toFixed(1)}k` : `${input_tokens}`;
    const outputFormatted = output_tokens > 1000 ? `${(output_tokens / 1000).toFixed(1)}k` : `${output_tokens}`;
    return `${inputFormatted} ${outputFormatted}`;
  }
  return `${input_tokens} ${output_tokens}`;
}

// Format token count, use k unit if greater than 1000
function formatTokensWithK(tokens: number): string {
  if (tokens > 1000) {
    return `${Math.round(tokens / 1000)}k`;
  }
  return `${tokens}`;
}

// Token statistics interface
interface TokenStats {
  totalUsed: number;
  totalRemaining: number;
  maxTokensFormatted: string;
}

// Calculate total token usage (based on token-status.sh logic)
function calculateTotalTokens(lines: string[]): TokenStats {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  
  // Process each line of transcript (JSONL format)
  for (const line of lines) {
    if (line.trim()) {
      try {
        const message = JSON.parse(line);
        if (message.message && message.message.usage) {
          const usage = message.message.usage;
          totalInputTokens += usage.input_tokens || 0;
          totalOutputTokens += usage.output_tokens || 0;
          totalCacheCreationTokens += usage.cache_creation_input_tokens || 0;
          totalCacheReadTokens += usage.cache_read_input_tokens || 0;
        }
      } catch (parseError) {
        // Ignore parsing errors, continue processing next line
        continue;
      }
    }
  }
  
  // Get token information from the last message
  let lastMessageCacheRead = 0;
  let lastInputTokens = 0;
  let lastOutputTokens = 0;
  let lastCacheCreationTokens = 0;
  
  if (lines.length > 0) {
    try {
      const lastMessage = JSON.parse(lines[lines.length - 1]);
      if (lastMessage.message && lastMessage.message.usage) {
        const usage = lastMessage.message.usage;
        lastMessageCacheRead = usage.cache_read_input_tokens || 0;
        lastInputTokens = usage.input_tokens || 0;
        lastOutputTokens = usage.output_tokens || 0;
        lastCacheCreationTokens = usage.cache_creation_input_tokens || 0;
      }
    } catch (parseError) {
      // Ignore parsing errors
    }
  }
  
  // Calculate total usage (based on token-status.sh logic)
  let totalUsed = 0;
  if (lastMessageCacheRead > 0) {
    // Add adjustment value to account for difference between cache_read and actual context
    const adjustment = lastInputTokens + lastOutputTokens + lastCacheCreationTokens;
    totalUsed = lastMessageCacheRead + adjustment;
    
    // Limit to reasonable range
    if (totalUsed > 200000) {
      totalUsed = 200000;
    }
  } else {
    // Fallback: use total input + output tokens
    totalUsed = totalInputTokens + totalOutputTokens;
    if (totalUsed === 0) {
      totalUsed = 138000; // Default value based on token-status.sh
    }
  }
  
  const maxTokens = 200000;
  const totalRemaining = Math.max(0, maxTokens - totalUsed);
  const maxTokensFormatted = `${Math.round(maxTokens / 1000)}k`;
  
  return {
    totalUsed,
    totalRemaining,
    maxTokensFormatted
  };
}

// Read theme configuration from user home directory
async function getProjectThemeConfig(): Promise<{ theme: StatusLineThemeConfig | null, style: string }> {
  try {
    // Only use fixed configuration file in home directory
    const configPath = CONFIG_FILE;
    
    // Check if configuration file exists
    try {
      await fs.access(configPath);
    } catch {
      return { theme: null, style: 'default' };
    }
    
    const configContent = await fs.readFile(configPath, "utf-8");
    const config = JSON5.parse(configContent);
    
    // Check if StatusLine configuration exists
    if (config.StatusLine) {
      // Get currently used style, default to 'default'
      const currentStyle = config.StatusLine.currentStyle || 'default';
      
      // Check if configuration for corresponding style exists
      if (config.StatusLine[currentStyle] && config.StatusLine[currentStyle].modules) {
        return { theme: config.StatusLine[currentStyle], style: currentStyle };
      }
    }
  } catch (error) {
    // If reading fails, return null
    // console.error("Failed to read theme config:", error);
  }
  
  return { theme: null, style: 'default' };
}

// Check if simple theme should be used (fallback solution)
// When USE_SIMPLE_ICONS environment variable is set, or when terminals that may not support Nerd Fonts are detected
function shouldUseSimpleTheme(): boolean {
  // Check environment variables
  if (process.env.USE_SIMPLE_ICONS === 'true') {
    return true;
  }
  
  // Check terminal type (some common terminals that don't support complex icons)
  const term = process.env.TERM || '';
  const unsupportedTerms = ['dumb', 'unknown'];
  if (unsupportedTerms.includes(term)) {
    return true;
  }
  
  // By default, assume terminal supports Nerd Fonts
  return false;
}

// Check if Nerd Fonts icons can be displayed correctly
// By checking terminal font information or using heuristic methods
function canDisplayNerdFonts(): boolean {
  // If environment variable explicitly specifies using simple icons, cannot display Nerd Fonts
  if (process.env.USE_SIMPLE_ICONS === 'true') {
    return false;
  }
  
  // Check some common terminal environment variables that support Nerd Fonts
  const fontEnvVars = ['NERD_FONT', 'NERDFONT', 'FONT'];
  for (const envVar of fontEnvVars) {
    const value = process.env[envVar];
    if (value && (value.includes('Nerd') || value.includes('nerd'))) {
      return true;
    }
  }
  
  // Check terminal type
  const termProgram = process.env.TERM_PROGRAM || '';
  const supportedTerminals = ['iTerm.app', 'vscode', 'Hyper', 'kitty', 'alacritty'];
  if (supportedTerminals.includes(termProgram)) {
    return true;
  }
  
  // Check COLORTERM environment variable
  const colorTerm = process.env.COLORTERM || '';
  if (colorTerm.includes('truecolor') || colorTerm.includes('24bit')) {
    return true;
  }
  
  // By default, assume Nerd Fonts can be displayed (but allow user override via environment variables)
  return process.env.USE_SIMPLE_ICONS !== 'true';
}

// Check if specific Unicode characters can be displayed correctly
// This is a simple heuristic check
function canDisplayUnicodeCharacter(char: string): boolean {
  // For Nerd Fonts icons, we assume terminals that support UTF-8 can display them
  // But it's actually difficult to detect accurately, so we rely on environment variables and terminal type detection
  try {
    // Check if terminal supports UTF-8
    const lang = process.env.LANG || process.env.LC_ALL || process.env.LC_CTYPE || '';
    if (lang.includes('UTF-8') || lang.includes('utf8') || lang.includes('UTF8')) {
      return true;
    }
    
    // Check LC_* environment variables
    const lcVars = ['LC_ALL', 'LC_CTYPE', 'LANG'];
    for (const lcVar of lcVars) {
      const value = process.env[lcVar];
      if (value && (value.includes('UTF-8') || value.includes('utf8'))) {
        return true;
      }
    }
  } catch (e) {
    // If check fails, return true by default
    return true;
  }
  
  // By default, assume it can be displayed
  return true;
}

export async function parseStatusLineData(input: StatusLineInput): Promise<string> {
  try {
    // Check if simple theme should be used
    const useSimpleTheme = shouldUseSimpleTheme();
    
    // Check if Nerd Fonts icons can be displayed
    const canDisplayNerd = canDisplayNerdFonts();
    
    // Determine theme to use: if user forces simple theme or cannot display Nerd Fonts, use simple theme
    const effectiveTheme = useSimpleTheme || !canDisplayNerd ? SIMPLE_THEME : DEFAULT_THEME;
    
    // Get theme configuration from home directory, if none exists use determined default configuration
    const { theme: projectTheme, style: currentStyle } = await getProjectThemeConfig();
    const theme = projectTheme || effectiveTheme;
    
    // Get current working directory and Git branch
    const workDir = input.workspace.current_dir;
    let gitBranch = "";
    
    try {
      // Try to get Git branch name
      gitBranch = execSync("git branch --show-current", {
        cwd: workDir,
        stdio: ["pipe", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch (error) {
      // If not a Git repository or retrieval fails, ignore the error
    }
    
    // Read last assistant message from transcript_path file and calculate total token usage
    const transcriptContent = await fs.readFile(input.transcript_path, "utf-8");
    const lines = transcriptContent.trim().split("\n");
    
    // Calculate total token usage (similar to token-status.sh logic)
    const tokenStats = calculateTotalTokens(lines);
    
    // Traverse backwards to find the last assistant message
    let model = "";
    let inputTokens = 0;
    let outputTokens = 0;
    
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const message: AssistantMessage = JSON.parse(lines[i]);
        if (message.type === "assistant" && message.message.model) {
          model = message.message.model;
          
          if (message.message.usage) {
            inputTokens = message.message.usage.input_tokens;
            outputTokens = message.message.usage.output_tokens;
          }
          break;
        }
      } catch (parseError) {
        // Ignore parsing errors, continue searching
        continue;
      }
    }
    
    // If model name not obtained from transcript, try to get from configuration file
    if (!model) {
      try {
        // Get project configuration file path
        const projectConfigPath = path.join(workDir, ".claude-code-router", "config.json");
        let configPath = projectConfigPath;
        
        // Check if project configuration file exists, if not use user home directory configuration file
        try {
          await fs.access(projectConfigPath);
        } catch {
          configPath = CONFIG_FILE;
        }
        
        // Read configuration file
        const configContent = await fs.readFile(configPath, "utf-8");
        const config = JSON5.parse(configContent);
        
        // Get model name from Router field's default content
        if (config.Router && config.Router.default) {
          const [, defaultModel] = config.Router.default.split(",");
          if (defaultModel) {
            model = defaultModel.trim();
          }
        }
      } catch (configError) {
        // If configuration file reading fails, ignore the error
      }
    }
    
    // If still no model name obtained, use display_name from model field in passed JSON data
    if (!model) {
      model = input.model.display_name;
    }
    
    // Get working directory name
    const workDirName = workDir.split("/").pop() || "";
    
    // Format usage information
    const usage = formatUsage(inputTokens, outputTokens);
    const [formattedInputTokens, formattedOutputTokens] = usage.split(" ");
    
    // Format total token information
    const totalUsedFormatted = formatTokensWithK(tokenStats.totalUsed);
    const totalRemainingFormatted = formatTokensWithK(tokenStats.totalRemaining);
    const totalTokensDisplay = `${totalUsedFormatted}/${tokenStats.maxTokensFormatted} used | ${totalRemainingFormatted} remaining`;
    
    // Define variable replacement mapping
    const variables = {
      workDirName,
      gitBranch,
      model,
      inputTokens: formattedInputTokens,
      outputTokens: formattedOutputTokens,
      totalTokens: totalTokensDisplay,
      totalUsed: totalUsedFormatted,
      totalRemaining: totalRemainingFormatted,
      maxTokens: tokenStats.maxTokensFormatted
    };
    
    // Determine style to use
    const isPowerline = currentStyle === 'powerline';
    
    // Render status line according to style
    if (isPowerline) {
      return await renderPowerlineStyle(theme, variables);
    } else {
      return await renderDefaultStyle(theme, variables);
    }
  } catch (error) {
    // Return empty string when error occurs
    return "";
  }
}

// Read theme configuration from user home directory (specified style)
async function getProjectThemeConfigForStyle(style: string): Promise<StatusLineThemeConfig | null> {
  try {
    // Only use fixed configuration file in home directory
    const configPath = CONFIG_FILE;
    
    // Check if configuration file exists
    try {
      await fs.access(configPath);
    } catch {
      return null;
    }
    
    const configContent = await fs.readFile(configPath, "utf-8");
    const config = JSON5.parse(configContent);
    
    // Check if StatusLine configuration exists
    if (config.StatusLine && config.StatusLine[style] && config.StatusLine[style].modules) {
      return config.StatusLine[style];
    }
  } catch (error) {
    // If reading fails, return null
    // console.error("Failed to read theme config:", error);
  }
  
  return null;
}

// Render default style status line
async function renderDefaultStyle(
  theme: StatusLineThemeConfig,
  variables: Record<string, string>
): Promise<string> {
  const modules = theme.modules || DEFAULT_THEME.modules;
  const parts: string[] = [];
  
  // Iterate through module array, render each module
  for (let i = 0; i < Math.min(modules.length, 5); i++) {
    const module = modules[i];
    const color = module.color ? getColorCode(module.color) : "";
    const background = module.background ? getColorCode(module.background) : "";
    const icon = module.icon || "";
    
    // If script type, execute script to get text
    let text = "";
    if (module.type === "script" && module.scriptPath) {
      text = await executeScript(module.scriptPath, variables);
    } else {
      text = replaceVariables(module.text, variables);
    }
    
    // Build display text
    let displayText = "";
    if (icon) {
      displayText += `${icon} `;
    }
    displayText += text;
    
    // If displayText is empty, or only has icon without actual text, skip this module
    if (!displayText || !text) {
      continue;
    }
    
    // Build module string
    let part = `${background}${color}`;
    part += `${displayText}${COLORS.reset}`;
    
    parts.push(part);
  }
  
  // Connect all parts with spaces
  return parts.join(" ");
}

// Powerline symbols
const SEP_RIGHT = "\uE0B0"; // 

// Color numbers (256 color table)
const COLOR_MAP: Record<string, number> = {
  // Basic color mapping to 256 colors
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  bright_black: 8,
  bright_red: 9,
  bright_green: 10,
  bright_yellow: 11,
  bright_blue: 12,
  bright_magenta: 13,
  bright_cyan: 14,
  bright_white: 15,
  // Bright background color mapping
  bg_black: 0,
  bg_red: 1,
  bg_green: 2,
  bg_yellow: 3,
  bg_blue: 4,
  bg_magenta: 5,
  bg_cyan: 6,
  bg_white: 7,
  bg_bright_black: 8,
  bg_bright_red: 9,
  bg_bright_green: 10,
  bg_bright_yellow: 11,
  bg_bright_blue: 12,
  bg_bright_magenta: 13,
  bg_bright_cyan: 14,
  bg_bright_white: 15,
  // Custom color mapping
  bg_bright_orange: 202,
  bg_bright_purple: 129,
};

// Get TrueColor RGB values
function getTrueColorRgb(colorName: string): { r: number; g: number; b: number } | null {
  // If predefined color, return corresponding RGB
  if (COLOR_MAP[colorName] !== undefined) {
    const color256 = COLOR_MAP[colorName];
    return color256ToRgb(color256);
  }
  
  // Handle hexadecimal colors
  if (colorName.startsWith('#') || /^[0-9a-fA-F]{6}$/.test(colorName) || /^[0-9a-fA-F]{3}$/.test(colorName)) {
    return hexToRgb(colorName);
  }
  
  // Handle background color hexadecimal
  if (colorName.startsWith('bg_#')) {
    return hexToRgb(colorName.substring(3));
  }
  
  return null;
}

// Convert 256 color table index to RGB values
function color256ToRgb(index: number): { r: number; g: number; b: number } | null {
  if (index < 0 || index > 255) return null;
  
  // ANSI 256 color table conversion
  if (index < 16) {
    // Basic colors
    const basicColors = [
      [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
      [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
      [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
      [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]
    ];
    return { r: basicColors[index][0], g: basicColors[index][1], b: basicColors[index][2] };
  } else if (index < 232) {
    // 216 colors: 6×6×6 color cube
    const i = index - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const rgb = [0, 95, 135, 175, 215, 255];
    return { r: rgb[r], g: rgb[g], b: rgb[b] };
  } else {
    // Grayscale colors
    const gray = 8 + (index - 232) * 10;
    return { r: gray, g: gray, b: gray };
  }
}

// Generate a seamlessly connected segment: text displayed on bgN, separator transitions from bgN to nextBgN
function segment(text: string, textFg: string, bgColor: string, nextBgColor: string | null): string {
  const bgRgb = getTrueColorRgb(bgColor);
  if (!bgRgb) {
    // If unable to get RGB, use default blue background
    const defaultBlueRgb = { r: 33, g: 150, b: 243 };
    const curBg = `\x1b[48;2;${defaultBlueRgb.r};${defaultBlueRgb.g};${defaultBlueRgb.b}m`;
    const fgColor = `\x1b[38;2;255;255;255m`;
    const body = `${curBg}${fgColor} ${text} \x1b[0m`;
    return body;
  }
  
  const curBg = `\x1b[48;2;${bgRgb.r};${bgRgb.g};${bgRgb.b}m`;
  
  // Get foreground color RGB
  let fgRgb = { r: 255, g: 255, b: 255 }; // Default foreground color is white
  const textFgRgb = getTrueColorRgb(textFg);
  if (textFgRgb) {
    fgRgb = textFgRgb;
  }
  
  const fgColor = `\x1b[38;2;${fgRgb.r};${fgRgb.g};${fgRgb.b}m`;
  const body = `${curBg}${fgColor} ${text} \x1b[0m`;
  
  if (nextBgColor != null) {
    const nextBgRgb = getTrueColorRgb(nextBgColor);
    if (nextBgRgb) {
      // Separator: foreground color is current segment's background color, background color is next segment's background color
      const sepCurFg = `\x1b[38;2;${bgRgb.r};${bgRgb.g};${bgRgb.b}m`;
      const sepNextBg = `\x1b[48;2;${nextBgRgb.r};${nextBgRgb.g};${nextBgRgb.b}m`;
      const sep = `${sepCurFg}${sepNextBg}${SEP_RIGHT}\x1b[0m`;
      return body + sep;
    }
    // If no next background color, assume terminal background is black and render black arrow
    const sepCurFg = `\x1b[38;2;${bgRgb.r};${bgRgb.g};${bgRgb.b}m`;
    const sepNextBg = `\x1b[48;2;0;0;0m`; // 黑色背景
    const sep = `${sepCurFg}${sepNextBg}${SEP_RIGHT}\x1b[0m`;
    return body + sep;
  }
  
  return body;
}

// Render Powerline style status line
async function renderPowerlineStyle(
  theme: StatusLineThemeConfig,
  variables: Record<string, string>
): Promise<string> {
  const modules = theme.modules || POWERLINE_THEME.modules;
  const segments: string[] = [];
  
  // Iterate through module array, render each module
  for (let i = 0; i < Math.min(modules.length, 5); i++) {
    const module = modules[i];
    const color = module.color || "white";
    const backgroundName = module.background || "";
    const icon = module.icon || "";
    
    // If script type, execute script to get text
    let text = "";
    if (module.type === "script" && module.scriptPath) {
      text = await executeScript(module.scriptPath, variables);
    } else {
      text = replaceVariables(module.text, variables);
    }
    
    // Build display text
    let displayText = "";
    if (icon) {
      displayText += `${icon} `;
    }
    displayText += text;
    
    // If displayText is empty, or only has icon without actual text, skip this module
    if (!displayText || !text) {
      continue;
    }
    
    // Get next module's background color (for separator)
    let nextBackground: string | null = null;
    if (i < modules.length - 1) {
      const nextModule = modules[i + 1];
      nextBackground = nextModule.background || null;
    }
    
    // Use module-defined background color, or provide default background color for Powerline style
    const actualBackground = backgroundName || "bg_bright_blue";
    
    // Generate segment, supports hexadecimal colors
    const segmentStr = segment(displayText, color, actualBackground, nextBackground);
    segments.push(segmentStr);
  }
  
  return segments.join("");
}
