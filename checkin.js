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
 * 检测拼图缺口位置
 * 使用 Jimp 增强版像素差异分析找到缺口
 * @param {Buffer} screenshot - 验证码截图缓冲区
 * @param {number} sliderWidth - 滑块宽度
 * @returns {Promise<{gapX: number, confidence: number}>} 缺口X坐标和置信度
 */
async function detectGap(screenshot, sliderWidth) {
  const image = await Jimp.read(screenshot);
  const width = image.bitmap.width;
  const height = image.bitmap.height;
  
  console.log(`📊 图像尺寸: ${width}x${height}，开始增强像素分析...`);
  
  const diffSums = new Array(width).fill(0);
  const gradientSums = new Array(width).fill(0);
  
  image.scan(0, 0, width, height, function(x, y, idx) {
    const gray = (this.bitmap.data[idx] + this.bitmap.data[idx + 1] + this.bitmap.data[idx + 2]) / 3;
    
    if (x > 0) {
      const prevGray = (this.bitmap.data[idx - 4] + this.bitmap.data[idx - 3] + this.bitmap.data[idx - 2]) / 3;
      const diff = Math.abs(gray - prevGray);
      diffSums[x] += diff;
      
      if (x > 1) {
        const prevPrevGray = (this.bitmap.data[idx - 8] + this.bitmap.data[idx - 7] + this.bitmap.data[idx - 6]) / 3;
        const prevDiff = Math.abs(prevGray - prevPrevGray);
        gradientSums[x] += Math.abs(diff - prevDiff);
      }
    }
  });
  
  const combinedScores = new Array(width).fill(0);
  for (let x = 0; x < width; x++) {
    combinedScores[x] = diffSums[x] * 0.7 + gradientSums[x] * 0.3;
  }
  
  let maxScore = 0;
  let gapX = Math.floor(width / 3);
  const minX = 30;
  const maxX = width - sliderWidth - 15;
  
  for (let x = minX; x < maxX; x++) {
    if (combinedScores[x] > maxScore) {
      maxScore = combinedScores[x];
      gapX = x;
    }
  }
  
  console.log(`🎯 检测到缺口位置: X = ${gapX}px (综合得分: ${maxScore.toFixed(0)})`);
  
  const compensation = sliderWidth * 0.3;
  const adjustedGapX = gapX - compensation;
  
  const topCandidates = [];
  for (let x = minX; x < maxX; x++) {
    if (combinedScores[x] > maxScore * 0.6) {
      topCandidates.push({x: x, score: combinedScores[x]});
    }
  }
  
  console.log(`🔍 找到 ${topCandidates.length} 个候选缺口位置`);
  console.log(`📐 滑块宽度: ${sliderWidth}px, 补偿值: ${compensation.toFixed(1)}px, 调整后缺口位置: ${adjustedGapX.toFixed(1)}px`);
  
  return { gapX: adjustedGapX, confidence: maxScore };
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
 * 查找滑块元素 - 多策略尝试
 * @param {import('playwright').Page} page
 * @returns {Promise<any>} 滑块元素或null
 */
async function findSliderHandle(page) {
  const sliderSelectors = [
    'div[class*="slider"] div[class*="block"]',
    'div[class*="slider"] .handler',
    'div[class*="handler"]',
    '.slider-btn',
    '.slider-block',
    '.captcha-slider div',
    'div[style*="position: absolute"][style*="left"]'
  ];
  
  for (const selector of sliderSelectors) {
    const el = page.locator(selector).filter({ visible: true });
    if (await el.count() > 0) {
      console.log(`✅ 使用选择器找到滑块: ${selector}`);
      return el.first();
    }
  }
  
  const filteredArrow = page.locator('div').filter({
    hasText: /^[>›]$/,
    visible: true
  });
  if (await filteredArrow.count() > 0) {
    console.log('✅ 使用箭头文本找到滑块');
    return filteredArrow.first();
  }
  
  console.log('🔍 通过文本内容遍历查找滑块...');
  const allDivs = await page.locator('div').elementHandles();
  for (const div of allDivs) {
    const text = await div.textContent().catch(() => '');
    if (text && ['>', '›', '▶'].includes(text.trim())) {
      const isVisible = await div.isVisible().catch(() => false);
      if (isVisible) {
        console.log('✅ 遍历找到滑块');
        return div;
      }
    }
  }
  
  const anyVisibleSlider = page.locator('div').filter({ visible: true });
  const count = await anyVisibleSlider.count();
  for (let i = 0; i < Math.min(count, 20); i++) {
    const el = anyVisibleSlider.nth(i);
    const box = await el.boundingBox().catch(() => null);
    if (box && box.width > 20 && box.width < 60 && box.height > 20 && box.height < 60) {
      console.log('✅ 通过尺寸特征找到滑块');
      return el;
    }
  }
  
  return null;
}

/**
 * 处理滑动验证码 - 增强版
 * 多策略滑块检测 + 改进缺口识别 + 拟人化滑动
 * @param {import('playwright').Page} page - Playwright 页面实例
 * @returns {Promise<boolean>} 返回是否验证成功
 */
async function handleSliderCaptcha(page) {
  try {
    console.log('🔍 增强版：查找拼图滑动验证码...');
    
    await page.waitForTimeout(2000 + Math.random() * 1000);
    
    const sliderHandle = await findSliderHandle(page);
    
    if (!sliderHandle) {
      console.log('❌ 未找到滑块');
      return false;
    }
    
    const isVisible = await sliderHandle.isVisible().catch(() => false);
    if (!isVisible) {
      console.log('❌ 滑块不可见');
      return false;
    }
    
    console.log('✅ 确认滑块可见');
    
    const handleBox = await sliderHandle.boundingBox();
    if (!handleBox) {
      console.log('❌ 无法获取滑块位置');
      return false;
    }
    
    console.log(`📍 滑块位置: x=${handleBox.x}, y=${handleBox.y}, w=${handleBox.width}, h=${handleBox.height}`);
    
    let containerFound = false;
    let captchaContainer = sliderHandle.locator('..').locator('..');
    let containerBox = await captchaContainer.boundingBox().catch(() => null);
    
    if (!containerBox) {
      captchaContainer = sliderHandle.locator('..');
      containerBox = await captchaContainer.boundingBox().catch(() => null);
    }
    
    if (!containerBox) {
      console.log('⚠️ 无法获取验证码容器，使用随机滑动策略');
      const containerWidth = handleBox.x + 250;
      const slideDistance = 120 + Math.floor(Math.random() * 80);
      console.log(`🎲 随机滑动距离：${slideDistance.toFixed(0)}px`);
      return await performSlide(page, handleBox, slideDistance);
    }
    
    containerFound = true;
    console.log(`🖼️ 验证码容器: x=${containerBox.x}, y=${containerBox.y}, w=${containerBox.width}, h=${containerBox.height}`);
    
    console.log('📸 截取验证码图片用于缺口检测...');
    const screenshot = await page.screenshot({
      clip: {
        x: containerBox.x,
        y: containerBox.y,
        width: containerBox.width,
        height: containerBox.height
      }
    });
    
    const { gapX, confidence } = await detectGap(screenshot, handleBox.width);
    const handleXInContainer = handleBox.x - containerBox.x;
    const containerLeftPadding = handleXInContainer > 0 ? handleXInContainer : 8;
    const slideDistance = Math.max(30, Math.min(containerBox.width - handleBox.width - 20, gapX - containerLeftPadding + handleBox.width * 0.4));
    
    console.log(`📏 计算滑动距离: 缺口X=${gapX.toFixed(1)}px, 滑块在容器内位置=${handleXInContainer.toFixed(1)}px, 左边距=${containerLeftPadding.toFixed(1)}px, 滑动距离=${slideDistance.toFixed(1)}px (置信度: ${confidence.toFixed(0)})`);
    
    if (confidence < 1500) {
      console.log('⚠️ 置信度较低，添加自适应扰动');
      const perturbationScale = Math.min(1, (1500 - confidence) / 1000);
      const perturbation = (Math.random() - 0.5) * 30 * perturbationScale;
      const newDistance = Math.max(30, Math.min(containerBox.width - handleBox.width - 10, slideDistance + perturbation));
      console.log(`🎲 置信度扰动系数: ${perturbationScale.toFixed(2)}, 添加扰动: ${perturbation.toFixed(1)}px, 调整后距离: ${newDistance.toFixed(1)}px`);
      return await performSlide(page, handleBox, newDistance);
    }
    
    return await performSlide(page, handleBox, slideDistance);
    
  } catch (error) {
    console.error(`❌ 处理滑动验证码时发生错误：${error.message}`);
    return false;
  }
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
