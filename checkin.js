/**
 * 自动签到脚本 - Playwright 版本
 * 用于 GitHub Actions 定时执行，自动访问指定网站完成签到操作
 */

require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const DdddOcr = require('ddddocr').default;
const Jimp = require('jimp');

let ocrInstance = null;
async function getOcr() {
  if (!ocrInstance) {
    ocrInstance = await DdddOcr.create();
  }
  return ocrInstance;
}

// 获取密钥
const CHECKIN_KEY = process.env.CHECKIN_KEY;
if (!CHECKIN_KEY) {
  console.error('❌ 未设置 CHECKIN_KEY 环境变量');
  process.exit(1);
}

// 签到网站 URL
const CHECKIN_URL = 'https://gpt.qt.cool/checkin';

// 截图输出目录（便于 Actions 归档和定位）
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || 'artifacts';

/**
 * 检测当前页面是否出现滑动验证码
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function detectSliderCaptcha(page) {
  const pageText = await page.innerText('body').catch(() => '');
  
  const captchaTexts = [
    '请完成滑块验证',
    '请先完成滑块验证',
    '请完成人机验证',
    '按住滑块向右拖动',
    '向右拖动完成验证',
    '拖动滑块',
    '滑动验证',
    '滑块验证',
    '安全验证',
    '验证失败',
    '验证超时'
  ];
  
  for (const text of captchaTexts) {
    if (pageText.includes(text)) {
      console.log(`✅ 通过页面文本检测到验证码: "${text}"`);
      return true;
    }
  }
  
  const sliderSelectors = [
    'div[class*="slider"]',
    '.captcha-slider',
    '.geetest',
    'div[style*="position: absolute"][style*="left"]',
    '.verify-slider'
  ];
  
  for (const selector of sliderSelectors) {
    const el = page.locator(selector).filter({ visible: true });
    if (await el.count() > 0) {
      console.log(`✅ 通过元素选择器检测到验证码: ${selector}`);
      return true;
    }
  }
  
  return false;
}

/**
 * 等待并处理验证码（支持多次检测与重试）- 增强版
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>} 返回是否验证成功
 */
async function waitAndHandleCaptchaWithRetry(page) {
  const maxAttempts = 4;
  const waitPerRoundMs = 4000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`⏳ 第${attempt}/${maxAttempts}轮：等待验证码或结果出现（${waitPerRoundMs}ms）...`);
    await page.waitForTimeout(waitPerRoundMs);

    const hasCaptcha = await detectSliderCaptcha(page);
    if (!hasCaptcha) {
      console.log(`ℹ️ 第${attempt}轮未检测到滑动验证码`);
      continue;
    }

    console.log(`🔐 第${attempt}轮检测到滑动验证码，开始处理...`);
    const captchaSuccess = await handleSliderCaptcha(page);

    if (captchaSuccess) {
      console.log('✅ 验证码验证成功');
      return true;
    }

    await page.waitForTimeout(2000 + Math.random() * 1000);

    const stillHasCaptcha = await detectSliderCaptcha(page);
    if (!stillHasCaptcha) {
      console.log('✅ 验证码已消失，疑似验证通过');
      return true;
    }

    console.log('🔄 验证失败，尝试刷新验证码并重新触发...');
    await page.waitForTimeout(800 + Math.random() * 400);
    
    try {
      await page.evaluate(() => {
        const refreshBtn = document.querySelector('[class*="refresh"], [class*="reload"], [title*="刷新"]');
        if (refreshBtn) {
          refreshBtn.click();
          console.log('已点击刷新验证码按钮');
        }
      });
      await page.waitForTimeout(1000 + Math.random() * 500);
    } catch (e) {
      console.log('ℹ️ 未找到刷新按钮，直接重新触发');
    }
    
    const exactCheckinButton = page.locator('button#checkinBtn.ci-btn.renew');
    if (await exactCheckinButton.count() > 0) {
      await page.evaluate(() => {
        const button = document.querySelector('button#checkinBtn.ci-btn.renew');
        if (button) {
          button.click();
        }
      });
      console.log('🖱️ 重新点击签到按钮（JavaScript 执行）');
      await page.waitForTimeout(1000 + Math.random() * 500);
    }

    console.log(`⚠️ 第${attempt}轮处理后验证码仍存在，准备下一轮重试`);
  }

  console.log('❌ 多轮检测后仍未通过验证码');
  return false;
}

/**
 * 尝试将页面切换为中文（点击右上角语言切换）
 * @param {import('playwright').Page} page
 * @returns {Promise<void>}
 */
async function switchToChineseIfNeeded(page) {
  const langSelectors = [
    'button.n5-chip.i18n-switch',
    '.i18n-switch',
    'button:has-text("中文")',
    'a:has-text("中文")',
    '[role="button"]:has-text("中文")',
    'button:has-text("ZH")',
    'a:has-text("ZH")',
    '[role="button"]:has-text("ZH")'
  ];

  for (const selector of langSelectors) {
    const el = page.locator(selector).first();
    if (await el.count() > 0) {
      try {
        await el.click({ timeout: 3000 });
        await page.waitForTimeout(1500);
        console.log(`🌐 已尝试切换页面语言为中文: ${selector}`);
        return;
      } catch (error) {
        console.log(`ℹ️ 语言切换点击失败(${selector}): ${error.message}`);
      }
    }
  }

  console.log('ℹ️ 未找到语言切换按钮（中文/ZH），继续当前语言执行');
}

/**
 * 判断页面是否出现登录失效提示
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function hasSessionExpiredHint(page) {
  const hints = [
    '未登录',
    '会话已过期',
    '登录已过期',
    '请先登录',
    'token 过期',
    'Token 过期'
  ];

  const pageText = await page.innerText('body').catch(() => '');
  return hints.some((hint) => pageText.includes(hint));
}

/**
 * 判断页面是否已进入有效登录态
 * 依据：已绑定邮箱 / 退出登录 / 签到相关按钮
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function isLoggedIn(page) {
  const pageText = await page.innerText('body').catch(() => '');

  // 检查是否有绑定邮箱或退出登录按钮（最可靠的登录标志）
  if (pageText.includes('已绑定:') || pageText.includes('退出登录')) {
    console.log('✅ 检测到"已绑定"或"退出登录"，确认已登录');
    return true;
  }

  // 检查是否有密码输入框且可见（未登录的标志）
  const passwordInput = page.locator('input#renewKey[type="password"]');
  const hasPasswordInput = await passwordInput.count() > 0;
  if (hasPasswordInput) {
    const isVisible = await passwordInput.first().isVisible().catch(() => false);
    if (isVisible) {
      console.log('✅ 检测到可见的密码输入框，说明未登录');
      return false;
    } else {
      console.log('ℹ️ 密码输入框存在但不可见，可能正在登录中');
    }
  }

  // 检查是否有登录按钮且可见（未登录的标志）
  const loginButton = page.locator('button:has-text("登录"), button:has-text("Login")');
  const hasLoginButton = await loginButton.count() > 0;
  if (hasLoginButton) {
    const isVisible = await loginButton.first().isVisible().catch(() => false);
    if (isVisible) {
      console.log('✅ 检测到可见的登录按钮，说明未登录');
      return false;
    }
  }

  // 检查是否有签到按钮
  const hasCheckinBtn = await page.locator('button:has-text("签到续期"), button:has-text("签到"), button#checkinBtn.ci-btn.renew').count() > 0;
  if (hasCheckinBtn) {
    console.log('✅ 检测到签到按钮，确认已登录');
    return true;
  }

  // 检查是否有今日已签到按钮
  const hasSignedBtn = await page.locator('button:has-text("今日已签到")').count() > 0;
  if (hasSignedBtn) {
    console.log('✅ 检测到"今日已签到"按钮，确认已登录');
    return true;
  }

  // 检查页面是否包含用户相关信息
  const userInfoSelectors = [
    '[class*="user"]',
    '[class*="avatar"]',
    '.profile',
    '[data-user]'
  ];
  for (const selector of userInfoSelectors) {
    const el = page.locator(selector).filter({ visible: true });
    if (await el.count() > 0) {
      console.log(`✅ 检测到用户元素 ${selector}，可能已登录`);
      return true;
    }
  }

  // 检查页面是否显示余额或使用次数等信息
  if (pageText.includes('余额') || pageText.includes('使用次数') || pageText.includes('剩余')) {
    console.log('✅ 检测到余额/使用次数信息，可能已登录');
    return true;
  }

  console.log('ℹ️ 无法确定登录状态');
  return false;
}

/**
 * 填充 KEY 并点击登录（可重试）
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function tryLoginWithRetry(page) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`🔄 第${attempt}/${maxAttempts}次尝试登录...`);

    // 在每次尝试前检查是否已经登录
    const alreadyLoggedIn = await isLoggedIn(page);
    if (alreadyLoggedIn) {
      console.log('✅ 检测到已处于登录状态，跳过本次尝试');
      return true;
    }

    // 强制使用指定输入框：<input class="ci-input" id="renewKey" ...>
    const exactInput = page.locator('input#renewKey.ci-input[type="password"]');
    if (await exactInput.count() === 0) {
      console.log('❌ 未找到指定的 API Key 输入框 #renewKey.ci-input');
      continue;
    }

    // 检查输入框是否可见
    const isVisible = await exactInput.first().isVisible().catch(() => false);
    if (!isVisible) {
      console.log('⚠️ 输入框不可见，尝试等待或刷新后重试');
      await page.waitForTimeout(2000);
      continue;
    }

    await exactInput.first().click({ timeout: 5000 });
    await exactInput.first().fill('');
    await exactInput.first().fill(CHECKIN_KEY);

    const typedValue = await exactInput.first().inputValue().catch(() => '');
    if (!typedValue || typedValue !== CHECKIN_KEY) {
      console.log('❌ API Key 输入校验失败（输入框值为空或不一致）');
      continue;
    }

    console.log('✅ 已输入 API Key 到 #renewKey（并通过输入校验）');

    const loginButtonSelectors = [
      'button:has-text("登录"), button:has-text("Login")',  // 优先查找登录按钮
      'button[type="submit"]',
      'button:has-text("确认")',
      'button:has-text("提交")',
      'button.ci-btn.renew'  // 最后才使用这个通用选择器
    ];

    let clicked = false;
    for (const selector of loginButtonSelectors) {
      const button = page.locator(selector);
      if (await button.count() > 0) {
        try {
          await button.first().click({ timeout: 5000 });
          console.log(`🖱️ 已点击登录按钮: ${selector}`);
          clicked = true;
          break;
        } catch (error) {
          console.error(`点击登录按钮失败(${selector}): ${error.message}`);
        }
      }
    }

    if (!clicked) {
      console.log('⚠️ 本轮未成功点击登录按钮');
      continue;
    }

    await page.waitForTimeout(2500);

    const loggedIn = await isLoggedIn(page);
    if (loggedIn) {
      console.log('✅ 登录状态有效（检测到邮箱/退出登录/签到按钮）');
      return true;
    }

    const expiredHint = await hasSessionExpiredHint(page);
    if (expiredHint) {
      console.log('⚠️ 检测到"未登录/会话已过期"提示，准备重试登录');
      continue;
    }

    // 没有明确过期提示，但也未进入有效登录态，继续重试
    console.log('⚠️ 登录后仍未进入有效状态，准备重试');
  }

  return false;
}

/**
 * 检测拼图缺口位置 — 增强版
 *
 * 三层递进策略：
 *  1. 高斯模糊降噪 + RGB 三通道 Sobel 梯度 → 垂直一致性评分 → 滑动窗口 → 多峰检测
 *  2. 若置信度低，尝试 Python OpenCV 模板匹配（需安装 opencv-python）
 *  3. 全部失败则返回随机位置 + 极低置信度（触发外部扰动）
 *
 * @param {Buffer} screenshot - 验证码截图缓冲区
 * @param {number} sliderWidth - 滑块宽度
 * @param {Buffer} [tileScreenshot] - 可选：拼图块截图，用于模板匹配
 * @returns {Promise<{gapX: number, confidence: number, method: string}>}
 */
async function detectGap(screenshot, sliderWidth, tileScreenshot) {
  // --- 策略 1：Jimp 增强边缘检测 ---
  const result = await detectGapByEdge(screenshot, sliderWidth);
  if (result.confidence >= 1.5) {
    console.log(`✅ 边缘检测置信度足够 (${result.confidence.toFixed(1)})，直接使用`);
    return { ...result, method: 'edge' };
  }

  // --- 策略 2：模板匹配（有拼图块截图时） ---
  if (tileScreenshot) {
    console.log('⚠️ 边缘检测置信度较低，尝试模板匹配...');
    const tmResult = await detectGapByTemplate(screenshot, tileScreenshot);
    if (tmResult && tmResult.confidence >= 0.3) {
      console.log(`✅ 模板匹配成功: gapX=${tmResult.gapX.toFixed(0)}, 置信度=${tmResult.confidence.toFixed(2)}`);
      return { ...tmResult, method: 'template' };
    }
  }

  // --- 策略 3：降级返回边缘检测结果 + 低置信度 ---
  console.log('⚠️ 所有检测方法置信度均低，使用边缘检测结果 + 随机扰动');
  return { ...result, method: 'edge_lowconf' };
}

/**
 * 基于 Jimp 的增强边缘检测 — 核心算法
 *
 * 改进点：
 *  - Gaussian blur 降噪（去纹理保留结构边缘）
 *  - RGB 三通道独立算梯度（不丢失颜色边缘信息）
 *  - 垂直一致性评分（真正缺口的边缘是竖直线，跨行一致）
 *  - 滑动窗口聚合（缺口阴影跨多列，单列噪声被平滑）
 *  - 局部峰值检测（不取全局最大，避免被最强单一噪声干扰）
 *  - Z-score 自适应置信度（不受图片尺寸和亮度影响）
 *
 * @param {Buffer} screenshot
 * @param {number} sliderWidth
 * @returns {Promise<{gapX: number, confidence: number}>}
 */
async function detectGapByEdge(screenshot, sliderWidth) {
  const image = await Jimp.read(screenshot);
  const width = image.bitmap.width;
  const height = image.bitmap.height;

  console.log(`📊 图像尺寸: ${width}x${height}，开始增强型边缘检测...`);

  // === Step 1: Gaussian blur 降噪 ===
  // 缺口阴影是低频宽带特征，纹理噪声是高频细粒度
  const blurred = image.clone();
  blurred.gaussian(2);

  // === Step 2: RGB 三通道水平梯度 + 垂直一致性 ===
  // 对于每一列 x，统计：
  //  - gradSum:   所有行的梯度总和（边缘能量）
  //  - gradRows:  梯度超过阈值的行数（垂直一致性）
  // 真正的缺口边缘会同时满足：高能量 + 高一致性
  const gradSum = new Array(width).fill(0);
  const gradRows = new Array(width).fill(0);
  const GRAD_THRESHOLD = 15;

  blurred.scan(0, 0, width, height, function (x, y, idx) {
    if (x <= 0 || x >= width - 1) return;

    const rL = this.bitmap.data[idx - 4];
    const gL = this.bitmap.data[idx - 3];
    const bL = this.bitmap.data[idx - 2];
    const rR = this.bitmap.data[idx + 4];
    const gR = this.bitmap.data[idx + 3];
    const bR = this.bitmap.data[idx + 2];

    // 三通道独立梯度，取最大值（颜色突变比灰度更敏感）
    const gradR = Math.abs(rR - rL);
    const gradG = Math.abs(gR - gL);
    const gradB = Math.abs(bR - bL);
    const maxGrad = Math.max(gradR, gradG, gradB);

    gradSum[x] += maxGrad;
    if (maxGrad > GRAD_THRESHOLD) {
      gradRows[x]++;
    }
  });

  // === Step 3: 综合评分 ===
  // energy × consistency 确保只有既强又一致的边缘才能高分
  const rawScores = new Array(width).fill(0);
  for (let x = 0; x < width; x++) {
    const energy = gradSum[x] / Math.max(1, height);
    const consistency = gradRows[x] / Math.max(1, height);
    rawScores[x] = energy * (0.3 + 0.7 * consistency);
  }

  // === Step 4: 滑动窗口平滑（消除单列噪声） ===
  const winSize = Math.max(3, Math.floor(sliderWidth / 6));
  const smoothed = new Array(width).fill(0);
  const winLen = winSize * 2 + 1;
  for (let x = winSize; x < width - winSize; x++) {
    let sum = 0;
    for (let wx = x - winSize; wx <= x + winSize; wx++) {
      sum += rawScores[wx];
    }
    smoothed[x] = sum / winLen;
  }

  // === Step 5: 搜索范围 ===
  const minX = Math.max(30, Math.floor(width * 0.08));
  const maxX = Math.min(width - sliderWidth - 15, Math.floor(width * 0.85));

  // === Step 6: 局部峰值检测 ===
  const peakWindow = Math.max(3, Math.floor(sliderWidth / 5));
  const peaks = [];
  for (let x = minX + peakWindow; x < maxX - peakWindow; x++) {
    let isPeak = true;
    for (let dx = -peakWindow; dx <= peakWindow; dx++) {
      if (dx !== 0 && smoothed[x] < smoothed[x + dx]) {
        isPeak = false;
        break;
      }
    }
    if (isPeak) {
      peaks.push({ x, score: smoothed[x] });
    }
  }

  peaks.sort((a, b) => b.score - a.score);

  // === Step 7: 自适应统计 ===
  const scoresInRange = smoothed.slice(minX, maxX);
  const mean = scoresInRange.reduce((a, b) => a + b, 0) / scoresInRange.length;
  const variance = scoresInRange.reduce((a, b) => a + (b - mean) ** 2, 0) / scoresInRange.length;
  const std = Math.sqrt(variance) || 1;

  // === Step 8: 确定缺口位置 ===
  let gapX;
  let zScore;

  if (peaks.length > 0 && peaks[0].score > mean + 0.3 * std) {
    // 取最高峰
    gapX = peaks[0].x;
    zScore = (peaks[0].score - mean) / std;
  } else {
    // 无显著峰值 -> 取全局最大（低置信度）
    let maxScore = 0;
    gapX = minX;
    for (let x = minX; x < maxX; x++) {
      if (smoothed[x] > maxScore) {
        maxScore = smoothed[x];
        gapX = x;
      }
    }
    zScore = (maxScore - mean) / std;
  }

  // 返回 RAW 缺口左边缘（不补偿），调用方负责距离计算
  console.log(`🎯 缺口左边缘: ${gapX}px (z-score: ${zScore.toFixed(2)}, std: ${std.toFixed(1)})`);
  if (peaks.length > 0) {
    console.log(`🔍 Top 候选: ${peaks.slice(0, 3).map(p => `x=${p.x} score=${p.score.toFixed(0)}`).join(' | ')}`);
  }

  return { gapX, confidence: Math.max(0, zScore) };
}

/**
 * Python OpenCV 模板匹配
 *
 * 流程：
 *  1. 将背景截图和拼图块截图保存为临时文件
 *  2. 调用 Python 子进程执行 cv2.matchTemplate
 *  3. 解析 stdout 中的匹配坐标和置信度
 *  4. 清理临时文件
 *
 * 需要 Python 环境已安装 opencv-python (cv2) + numpy
 *
 * @param {Buffer} masterScreenshot - 验证码容器截图（背景图）
 * @param {Buffer} tileScreenshot   - 拼图块截图（滑块图）
 * @returns {Promise<{gapX: number, confidence: number} | null>}
 */
async function detectGapByTemplate(masterScreenshot, tileScreenshot) {
  const fs = require('fs');
  const path = require('path');
  const { execSync } = require('child_process');

  const tmpDir = path.join(SCREENSHOT_DIR, '.tmp_template');
  fs.mkdirSync(tmpDir, { recursive: true });

  const masterPath = path.join(tmpDir, 'master.png');
  const tilePath = path.join(tmpDir, 'tile.png');

  try {
    fs.writeFileSync(masterPath, masterScreenshot);
    fs.writeFileSync(tilePath, tileScreenshot);

    // 用 Base64 传路径避免 Windows 反斜杠转义问题
    const esc = (p) => Buffer.from(p).toString('base64');

    const script = `
import cv2
import numpy as np
import json
import sys, base64, os

def decode_path(b64):
    return base64.b64decode(b64).decode("utf-8")

master_path = decode_path("${esc(masterPath)}")
tile_path   = decode_path("${esc(tilePath)}")

master = cv2.imread(master_path)
tile   = cv2.imread(tile_path, cv2.IMREAD_UNCHANGED)

if master is None:
    print(json.dumps({"error": "cannot read master image"}))
    sys.exit(1)
if tile is None:
    print(json.dumps({"error": "cannot read tile image"}))
    sys.exit(1)

# 如果 tile 有 alpha 通道，转换为 3 通道
if len(tile.shape) == 3 and tile.shape[2] == 4:
    tile = cv2.cvtColor(tile, cv2.COLOR_BGRA2BGR)

h, w = tile.shape[:2]
mh, mw = master.shape[:2]

if h > mh or w > mw:
    print(json.dumps({"error": f"tile ({w}x{h}) larger than master ({mw}x{mh})"}))
    sys.exit(1)

# 尝试两种匹配方法，取置信度更高的结果
methods = [
    ("TM_CCOEFF_NORMED", cv2.TM_CCOEFF_NORMED),
    ("TM_CCORR_NORMED",  cv2.TM_CCORR_NORMED),
]

best = {"gapX": 0, "confidence": -1, "method": ""}

for name, method in methods:
    result = cv2.matchTemplate(master, tile, method)
    _, max_val, _, max_loc = cv2.minMaxLoc(result)
    if max_val > best["confidence"]:
        best["confidence"] = round(float(max_val), 4)
        best["gapX"] = int(max_loc[0] + w / 2)
        best["method"] = name

print(json.dumps(best))
`;
    const scriptPath = path.join(tmpDir, 'match.py');
    fs.writeFileSync(scriptPath, script);

    const stdout = execSync(`python "${scriptPath}"`, {
      timeout: 30000,
      encoding: 'utf-8',
    }).trim();

    if (!stdout) {
      console.log('❌ 模板匹配 Python 无输出');
      return null;
    }

    const data = JSON.parse(stdout);
    if (data.error) {
      console.log(`❌ 模板匹配失败: ${data.error}`);
      return null;
    }

    console.log(`🔍 模板匹配: gapX=${data.gapX}, confidence=${data.confidence}, method=${data.method}`);
    return { gapX: data.gapX, confidence: data.confidence };
  } catch (err) {
    console.log(`ℹ️ 模板匹配不可用: ${err.message}`);
    return null;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

/**
 * 从页面中提取拼图块截图（如果存在）
 * @param {import('playwright').Page} page
 * @returns {Promise<Buffer|null>}
 */
async function extractTileImage(page) {
  // 尝试多种选择器找到拼图块元素
  const tileSelectors = [
    // 常见拼图块图元素
    'div[class*="block"] img',
    'div[class*="tile"] img',
    'div[class*="puzzle"] img',
    'div[class*="slice"] img',
    'div[class*="graph"] img',
    'canvas[class*="block"]',
    'canvas[class*="tile"]',
  ];

  for (const selector of tileSelectors) {
    try {
      const el = page.locator(selector).filter({ visible: true }).first();
      if (await el.count() > 0) {
        const box = await el.boundingBox();
        if (box && box.width > 10 && box.height > 10) {
          const buf = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
          console.log(`✅ 提取到拼图块截图: ${selector} (${box.width.toFixed(0)}x${box.height.toFixed(0)})`);
          return buf;
        }
      }
    } catch (_) { /* 忽略单个选择器失败 */ }
  }

  return null;
}

/**
 * 生成拟人化滑动轨迹 - 增强版，包含加速-减速和回退微调
 * @param {number} distance - 总滑动距离
 * @returns {Array<{x: number, y: number, delay: number}>}
 */
function generateHumanTrack(distance) {
  const tracks = [];
  let current = 0;
  
  const totalTime = 800 + Math.random() * 400;
  const baseDelay = totalTime / distance;
  
  const phase1End = distance * 0.25;
  const phase2End = distance * 0.75;
  
  const noiseFactor = 0.3 + Math.random() * 0.2;
  
  while (current < distance) {
    let step;
    let delay;
    
    const progress = current / distance;
    
    if (progress < 0.25) {
      step = 4 + Math.random() * 10;
      delay = baseDelay * (0.8 + Math.random() * 0.6);
    } else if (progress < 0.75) {
      step = 3 + Math.random() * 6;
      delay = baseDelay * (1.0 + Math.random() * 0.8);
    } else {
      step = 1 + Math.random() * 3;
      delay = baseDelay * (1.5 + Math.random() * 1.0);
    }
    
    if (progress > 0.3 && progress < 0.7 && Math.random() < 0.05) {
      const pauseDelay = 50 + Math.random() * 100;
      tracks.push({ x: 0, y: 0, delay: pauseDelay });
    }
    
    if (progress > 0.6 && Math.random() < 0.3) {
      const backStep = -(0.3 + Math.random() * 2);
      step += backStep;
    }
    
    if (progress > 0.8 && Math.random() < 0.4) {
      const microAdjust = (Math.random() - 0.5) * 1.5;
      step += microAdjust;
    }
    
    const yOffset = (Math.random() - 0.5) * (4 + noiseFactor * 3);
    
    const remaining = distance - current;
    if (Math.abs(step) > Math.abs(remaining)) {
      step = remaining;
    }
    
    if (step !== 0) {
      tracks.push({
        x: step,
        y: yOffset,
        delay: Math.max(5, delay + (Math.random() - 0.5) * 20)
      });
    }
    
    current += step;
  }
  
  if (Math.abs(distance - current) > 0.5) {
    tracks.push({
      x: distance - current,
      y: (Math.random() - 0.5) * 3,
      delay: 50 + Math.random() * 100
    });
  }
  
  if (Math.random() < 0.8) {
    const finalAdjust = (Math.random() - 0.5) * 4;
    if (Math.abs(finalAdjust) > 0.3) {
      tracks.push({
        x: finalAdjust,
        y: (Math.random() - 0.5) * 1.5,
        delay: 80 + Math.random() * 120
      });
    }
  }
  
  return tracks;
}

/**
 * 查找滑块元素 - 多策略尝试（增强版）
 * @param {import('playwright').Page} page
 * @returns {Promise<any>} 滑块元素或null
 */
async function findSliderHandle(page) {
  // 策略 1: 精确 CSS 选择器
  const sliderSelectors = [
    'div[class*="slider"] div[class*="block"]',
    'div[class*="slider"] .handler',
    'div[class*="handler"]',
    '.slider-btn',
    '.slider-block',
    '.captcha-slider div',
    'div[class*="slider"] div[class*="btn"]',
    'div[class*="slider"] div[class*="handle"]',
    // 增加更多通用选择器
    'div[style*="position: absolute"][style*="left"][style*="top"]',
    'div[class*="slide"] div[class*="block"]',
    'div[class*="slide"] div[class*="btn"]',
    'div[class*="verify"] div[class*="block"]',
    'div[class*="verify"] div[class*="btn"]',
  ];

  for (const selector of sliderSelectors) {
    const el = page.locator(selector).filter({ visible: true });
    if (await el.count() > 0) {
      console.log(`✅ 使用选择器找到滑块: ${selector}`);
      return el.first();
    }
  }

  // 策略 2: 箭头字符匹配
  const arrowSelector = page.locator('div').filter({
    hasText: /^[>›▶→]$/,
    visible: true,
  });
  if (await arrowSelector.count() > 0) {
    console.log('✅ 使用箭头文本找到滑块');
    return arrowSelector.first();
  }

  // 策略 3: 遍历 DOM 找箭头字符
  console.log('🔍 遍历 DOM 查找箭头字符...');
  const allDivs = await page.locator('div').elementHandles();
  for (const div of allDivs) {
    const text = await div.textContent().catch(() => '');
    if (text && ['>', '›', '▶', '→'].includes(text.trim())) {
      const isVisible = await div.isVisible().catch(() => false);
      if (isVisible) {
        console.log('✅ 遍历找到滑块');
        return div;
      }
    }
  }

  // 策略 4: 尺寸启发式（找 20-80px 的可见方形元素）
  console.log('🔍 使用尺寸特征查找滑块...');
  const candidates = page.locator('div, span, a, i, em').filter({ visible: true });
  const count = await candidates.count();
  for (let i = 0; i < Math.min(count, 40); i++) {
    const el = candidates.nth(i);
    const box = await el.boundingBox().catch(() => null);
    if (box && box.width > 20 && box.width < 80 && box.height > 20 && box.height < 80) {
      const ratio = box.width / box.height;
      if (ratio > 0.5 && ratio < 2.0) {
        console.log(`✅ 通过尺寸特征找到滑块 (${box.width.toFixed(0)}x${box.height.toFixed(0)})`);
        return el;
      }
    }
  }

  return null;
}

/**
 * 处理滑动验证码 — 三阶段递进式
 *
 * 阶段 A: 精确检测（边缘检测 → 模板匹配）
 *   1. 找滑块 → 找容器 → 分别截图背景和拼图块
 *   2. 先用 Jimp 边缘检测（快速、零依赖）
 *   3. 置信度不足且有拼图块截图时 → Python OpenCV 模板匹配
 *   4. 根据缺口中心 - 滑块中心 计算精确滑动距离
 *
 * 阶段 B: 自适应补偿（当置信度偏低时）
 *   - 以检测位置为中心，按 ±10~50px 范围尝试多次滑动
 *   - 每次滑动后检查验证码是否消失
 *
 * 阶段 C: 完全降级（无容器 / 极低置信度）
 *   - 宽范围随机滑动，重复尝试
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function handleSliderCaptcha(page) {
  try {
    console.log('🔍 [阶段 A] 查找滑块验证码...');
    await page.waitForTimeout(2000 + Math.random() * 1000);

    // === A-1: 找滑块 ===
    const sliderHandle = await findSliderHandle(page);
    if (!sliderHandle) {
      console.log('❌ 未找到滑块元素');
      return false;
    }
    if (!(await sliderHandle.isVisible().catch(() => false))) {
      console.log('❌ 滑块不可见');
      return false;
    }

    const handleBox = await sliderHandle.boundingBox();
    if (!handleBox) {
      console.log('❌ 无法获取滑块位置');
      return false;
    }
    console.log(`📍 滑块: x=${handleBox.x.toFixed(0)} y=${handleBox.y.toFixed(0)} w=${handleBox.width.toFixed(0)} h=${handleBox.height.toFixed(0)}`);

    // === A-2: 找验证码容器 ===
    // 尝试向上找 2～3 层父容器
    let containerBox = null;
    for (let level = 1; level <= 3; level++) {
      let el = sliderHandle;
      for (let p = 0; p < level; p++) el = el.locator('..');
      containerBox = await el.boundingBox().catch(() => null);
      if (containerBox) break;
    }

    if (!containerBox) {
      console.log('⚠️ 无法定位验证码容器 → 进入 [阶段 B] 宽范围滑动');
      return await slideWithRetry(page, handleBox, null);
    }
    console.log(`🖼️ 容器: x=${containerBox.x.toFixed(0)} y=${containerBox.y.toFixed(0)} w=${containerBox.width.toFixed(0)} h=${containerBox.height.toFixed(0)}`);

    // === A-3: 截图背景 ===
    const masterShot = await page.screenshot({
      clip: {
        x: containerBox.x,
        y: containerBox.y,
        width: containerBox.width,
        height: containerBox.height,
      },
    });

    // === A-4: 尝试提取拼图块截图（供模板匹配使用） ===
    let tileShot = null;
    try {
      tileShot = await extractTileImage(page);
    } catch (_) { /* ignore */ }

    // === A-5: 检测缺口 ===
    const { gapX, method } = await detectGap(masterShot, handleBox.width, tileShot);

    // === A-6: 计算精确滑动距离 ===
    // 坐标系统一到容器内：
    //   gapCenter  = gap的左边缘 + 滑块半宽  (缺口中心)
    //   sliderCenter = handleBox - containerBox + handle半宽
    //   slideDist = gapCenter - sliderCenter
    const sliderCenterInContainer = (handleBox.x - containerBox.x) + handleBox.width / 2;
    const gapCenter = gapX + handleBox.width / 2;
    let slideDistance = gapCenter - sliderCenterInContainer;

    // 边界钳位
    slideDistance = Math.max(10, Math.min(containerBox.width - handleBox.width - 10, slideDistance));

    // 估算精度（模板匹配精读 ±5px，边缘检测 ±15px，低置信度 ±30px）
    let estimatedError = 15;
    if (method === 'template') estimatedError = 5;
    else if (method === 'edge_lowconf') estimatedError = 30;

    console.log(`📏 缺口左边缘=${gapX.toFixed(0)} 缺口中心=${gapCenter.toFixed(0)} ` +
      `滑块中心(容器内)=${sliderCenterInContainer.toFixed(0)} ` +
      `滑动距离=${slideDistance.toFixed(0)} ` +
      `(method=${method}, 精度±${estimatedError}px)`);

    // === A-7: 执行滑动 ===
    return await performSlide(page, handleBox, slideDistance);

  } catch (error) {
    console.error(`❌ handleSliderCaptcha 错误: ${error.message}`);
    return false;
  }
}

/**
 * 带重试的宽范围滑动（降级策略）
 * 当找不到容器或置信度极低时使用
 */
async function slideWithRetry(page, handleBox, containerBox) {
  const maxWidth = containerBox ? containerBox.width - handleBox.width - 15 : 300;
  const distances = [];

  // 生成多个候选距离（覆盖不同的可能位置）
  for (let d = 40; d < maxWidth; d += 20 + Math.floor(Math.random() * 15)) {
    distances.push(d);
  }

  // 尝试 3 次滑动
  for (let attempt = 0; attempt < 3; attempt++) {
    if (distances.length === 0) break;
    const idx = Math.floor(Math.random() * distances.length);
    const dist = distances.splice(idx, 1)[0];
    console.log(`🔄 [阶段 B] 尝试 #${attempt + 1}: 滑动距离=${dist.toFixed(0)}px`);

    const ok = await performSlide(page, handleBox, dist);
    if (ok) return true;

    await page.waitForTimeout(1000 + Math.random() * 1000);
  }

  console.log('❌ [阶段 B] 所有尝试均失败');
  return false;
}

/**
 * 执行拟人化滑动操作 - 增强版
 * @param {import('playwright').Page} page
 * @param {any} handleBox
 * @param {number} slideDistance
 * @returns {Promise<boolean>}
 */
async function performSlide(page, handleBox, slideDistance) {
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2 + (Math.random() - 0.5) * 5;
  const endX = startX + slideDistance;
  
  console.log(`🚀 开始滑动：从 (${startX.toFixed(1)}, ${startY.toFixed(1)}) 到 (${endX.toFixed(1)}, ${startY.toFixed(1)})`);
  
  await page.waitForTimeout(200 + Math.random() * 300);
  await page.mouse.move(startX, startY, { steps: 10 });
  await page.waitForTimeout(100 + Math.random() * 200);
  await page.mouse.down();
  await page.waitForTimeout(80 + Math.random() * 120);
  
  const tracks = generateHumanTrack(slideDistance);
  let currentX = startX;
  let currentY = startY;
  
  console.log(`👤 生成了 ${tracks.length} 个轨迹点，开始滑动...`);
  
  for (const track of tracks) {
    currentX += track.x;
    currentY += track.y;
    await page.mouse.move(currentX, currentY, { steps: 3 + Math.floor(Math.random() * 7) });
    await page.waitForTimeout(track.delay);
  }
  
  const finalJitter = (Math.random() - 0.5) * 4;
  await page.mouse.move(endX + finalJitter, startY + (Math.random() - 0.5) * 3);
  await page.waitForTimeout(400 + Math.random() * 300);
  await page.mouse.up();
  
  console.log('✅ 滑块拖动完成，等待验证结果...');
  
  await page.waitForTimeout(2000 + Math.random() * 2000);
  
  let stillHasCaptcha = await detectSliderCaptcha(page);
  if (!stillHasCaptcha) {
    console.log('✅ 验证码已消失，验证成功');
    return true;
  }
  
  console.log('⏳ 验证码仍存在，等待动画完成...');
  await page.waitForTimeout(3000 + Math.random() * 2000);
  
  stillHasCaptcha = await detectSliderCaptcha(page);
  if (!stillHasCaptcha) {
    console.log('✅ 验证码动画完成后消失，验证成功');
    return true;
  }
  
  console.log('⏳ 等待滑块归位...');
  await page.waitForTimeout(2000 + Math.random() * 1000);
  
  stillHasCaptcha = await detectSliderCaptcha(page);
  if (!stillHasCaptcha) {
    console.log('✅ 滑块归位后验证码消失，验证成功');
    return true;
  }
  
  console.log('❌ 验证码仍然存在，验证失败');
  return false;
}

/**
 * 主签到函数
 */
async function autoCheckin() {
  let browser = null;
  
  try {
    console.log('🚀 开始执行自动签到脚本');
    
    // 启动浏览器 - 无头模式用于 GitHub Actions 定时执行
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--start-maximized'
      ]
    });
    
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true
    });
    
    const page = await context.newPage();
    
    // 监听页面日志
    page.on('console', msg => console.log(`📄 页面日志: ${msg.text()}`));
    page.on('pageerror', err => console.error(`❌ 页面错误: ${err.message}`));
    
    // 访问签到页面
    console.log(`🌐 正在访问签到页面: ${CHECKIN_URL}`);
    await page.goto(CHECKIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // 注入脚本绕过自动化检测
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
      window.navigator.chrome = {
        runtime: {},
      };
    });
    
    console.log('✅ 页面加载完成');
    
    // 等待页面完全加载
    await page.waitForTimeout(2000 + Math.random() * 1000);
    
    // 确保截图目录存在
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    console.log(`📁 截图输出目录: ${path.resolve(SCREENSHOT_DIR)}`);

    // 优先尝试切换中文界面，再继续后续步骤
    await switchToChineseIfNeeded(page);

    // 截图记录初始状态
    const initialScreenshotPath = path.join(SCREENSHOT_DIR, '1_initial.png');
    await page.screenshot({ path: initialScreenshotPath, fullPage: true });
    console.log(`📸 已保存初始状态截图: ${initialScreenshotPath}`);
    
    // 检查是否已经登录（优先依据绑定邮箱/退出登录等稳定标识）
    const initialLoggedIn = await isLoggedIn(page);

    if (initialLoggedIn) {
      console.log('✅ 检测到已登录状态');
    } else {
      console.log('🔐 未登录，需要先登录');
      
      const loginSuccess = await tryLoginWithRetry(page);

      // 截图记录登录尝试后状态
      const afterInputScreenshotPath = path.join(SCREENSHOT_DIR, '2_after_input.png');
      await page.screenshot({ path: afterInputScreenshotPath, fullPage: true });
      console.log(`📸 已保存登录尝试后截图: ${afterInputScreenshotPath}`);

      if (!loginSuccess) {
        throw new Error('多次重试后仍未登录成功（可能未登录或会话已过期）');
      }

      console.log('✅ 登录流程完成');
    }
    
    // 截图记录登录后状态
    const loggedInScreenshotPath = path.join(SCREENSHOT_DIR, '3_logged_in.png');
    await page.screenshot({ path: loggedInScreenshotPath, fullPage: true });
    console.log(`📸 已保存登录后截图: ${loggedInScreenshotPath}`);
    
    // 点击"签到"或"签到续期"按钮 - 优先使用精确选择器
    console.log('🖱️ 寻找并点击签到按钮...');
    
    // 尝试精确选择器 - 使用 JavaScript 执行点击
    const exactCheckinButton = page.locator('button#checkinBtn.ci-btn.renew');
    if (await exactCheckinButton.count() > 0) {
      console.log('✅ 找到精确的签到按钮');
      await page.evaluate(() => {
        const button = document.querySelector('button#checkinBtn.ci-btn.renew');
        if (button) {
          button.click();
        }
      });
      console.log('🖱️ 点击签到按钮（JavaScript 执行）');
    } else {
      // 尝试"签到续期"按钮 - 使用 JavaScript 执行点击
      const renewCheckinButton = page.locator('button:has-text("签到续期")');
      if (await renewCheckinButton.count() > 0) {
        console.log('✅ 找到签到续期按钮');
        await page.evaluate(() => {
          const buttons = document.querySelectorAll('button');
          for (const btn of buttons) {
            if (btn.textContent && btn.textContent.includes('签到续期')) {
              btn.click();
              break;
            }
          }
        });
        console.log('🖱️ 点击签到续期按钮（JavaScript 执行）');
      } else {
        // 尝试"签到"按钮 - 使用 JavaScript 执行点击
        const checkinButton = page.locator('button:has-text("签到")');
        if (await checkinButton.count() > 0) {
          console.log('✅ 找到签到按钮');
          await page.evaluate(() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
              if (btn.textContent && btn.textContent.includes('签到')) {
                btn.click();
                break;
              }
            }
          });
          console.log('️ 点击签到按钮（JavaScript 执行）');
        } else {
          throw new Error('未找到签到按钮');
        }
      }
    }
    
    // 等待并尝试处理验证码（多轮检测 + 重试）
    const captchaPassed = await waitAndHandleCaptchaWithRetry(page);
    
    if (!captchaPassed) {
      throw new Error('验证码验证失败，无法继续签到');
    }

    // 截图查看点击后的状态（含验证码处理结果）
    const afterClickScreenshotPath = path.join(SCREENSHOT_DIR, '4_after_click.png');
    await page.screenshot({ path: afterClickScreenshotPath, fullPage: true });
    console.log(`📸 已保存点击后截图：${afterClickScreenshotPath}`);

    // 等待签到结果
    console.log('⏳ 等待签到结果...');
    await page.waitForTimeout(5000);
    
    // 检查是否有任何成功提示消息（Toast/Snackbar/Notification）
    try {
      const successMessages = await page.locator('.message, .toast, .snackbar, .notification, [class*="message"], [class*="toast"], [class*="success"]').all();
      for (const msg of successMessages) {
        const text = await msg.textContent();
        if (text && (text.includes('成功') || text.includes('success') || text.includes('已签到'))) {
          console.log(`✅ 检测到成功提示：${text}`);
        }
      }
    } catch (e) {
      // 忽略错误
    }

    // 刷新页面以确保状态更新
    console.log('🔄 刷新页面以更新签到状态...');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    
    // 等待日历加载完成
    console.log('📅 等待日历加载...');
    try {
      await page.waitForSelector('.ci-cal-day', { state: 'visible', timeout: 5000 });
      console.log('✅ 日历已加载');
    } catch (e) {
      console.log('⚠️ 日历加载超时，继续检查');
    }
    
    // 截图记录最终结果
    const finalResultScreenshotPath = path.join(SCREENSHOT_DIR, '5_final_result.png');
    await page.screenshot({ path: finalResultScreenshotPath, fullPage: true });
    console.log(`📸 已保存最终结果截图: ${finalResultScreenshotPath}`);
    
    // 检查签到成功状态
    console.log('🔍 检查签到成功状态...');
    
    // 1. 检查按钮文本是否变为"今日已签到"或"已签到"
    const checkinButton = page.locator('button#checkinBtn.ci-btn.renew');
    if (await checkinButton.count() > 0) {
      const buttonText = await checkinButton.textContent();
      console.log(`📝 签到按钮文本：${buttonText}`);
      // 检查多种可能的成功状态文本
      const successTexts = ['今日已签到', '已签到', 'Signed', 'Renewed'];
      const isSuccess = successTexts.some(text => buttonText && buttonText.includes(text));
      if (isSuccess) {
        console.log(`🎉 检测到按钮状态变为：${buttonText}`);
        return true;
      }
    }
    
    // 2. 检查页面是否有"今日已签到"按钮
    const hasSignedButtonFinal = await page.locator('button:has-text("今日已签到")').count() > 0;
    if (hasSignedButtonFinal) {
      console.log('🎉 检测到"今日已签到"按钮，签到成功！');
      return true;
    }
    
    // 3. 严格检查签到日历中今天是否有标记
    const today = new Date().getDate();
    console.log(`📅 检查今天(${today}号)是否有签到标记...`);
    const todayCell = await page.locator(`text="${today}"`).first();
    
    if (await todayCell.count() > 0) {
      // 检查父元素是否有签到标记
      const parent = await todayCell.locator('..');
      const hasSignMark = await parent.locator('.dot, .checked, [class*="sign"]').count() > 0;
      
      if (hasSignMark) {
        console.log(`🎉 签到成功！${today}号已有签到标记`);
        return true;
      } else {
        console.log(`ℹ️ ${today}号未发现签到标记`);
      }
    } else {
      console.log(`ℹ️ 未找到日期${today}的日历单元格`);
    }
    
    console.log('⚠️ 未检测到明确的签到成功标志');
    
    // 保存页面 HTML 以便调试
    const pageHtml = await page.content();
    const htmlPath = path.join(SCREENSHOT_DIR, 'debug_page.html');
    fs.writeFileSync(htmlPath, pageHtml);
    console.log(`📄 已保存页面 HTML: ${htmlPath}`);
    
    return false;
    
  } catch (error) {
    console.error(`❌ 签到过程中发生错误: ${error.message}`);
    
    // 尝试保存错误截图
    if (browser) {
      try {
        const pages = await browser.pages();
        if (pages.length > 0) {
          const errorScreenshotPath = path.join(SCREENSHOT_DIR, 'error_screenshot.png');
          await pages[0].screenshot({ path: errorScreenshotPath, fullPage: true });
          console.log(`📸 已保存错误页面截图: ${errorScreenshotPath}`);
        }
      } catch (screenshotError) {
        console.error(`截图保存失败: ${screenshotError.message}`);
      }
    }
    
    throw error;
  } finally {
    if (browser) {
      await browser.close();
      console.log('🔒 浏览器已关闭');
    }
  }
}

// 执行签到
(async () => {
  try {
    console.log('========== 🚀 开始签到测试（Playwright 版本） ==========');
    const success = await autoCheckin();
    
    if (success) {
      console.log('✅ 签到成功');
      process.exit(0);
    } else {
      console.log('❌ 签到失败');
      process.exit(1);
    }
  } catch (error) {
    console.error(`❌ 签到失败: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
})();
