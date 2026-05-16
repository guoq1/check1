/**
 * 自动签到脚本 - Playwright 版本
 * 用于 GitHub Actions 定时执行，自动访问指定网站完成签到操作
 */

require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const DdddOcr = require('ddddocr').default;
const ocr = new DdddOcr();

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
  // 尝试通过页面文本检测
  const pageText = await page.innerText('body').catch(() => '');
  if (pageText.includes('请完成滑块验证') || 
      pageText.includes('请先完成滑块验证') || 
      pageText.includes('请完成人机验证') || 
      pageText.includes('按住滑块向右拖动')) {
    console.log('✅ 通过页面文本检测到验证码');
    return true;
  }
  
  return false;
}

/**
 * 等待并处理验证码（支持多次检测与重试）
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>} 返回是否验证成功
 */
async function waitAndHandleCaptchaWithRetry(page) {
  const maxAttempts = 3;
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

    // 给页面时间完成校验回调
    await page.waitForTimeout(2500);

    // 检查是否还需要验证
    const stillHasCaptcha = await detectSliderCaptcha(page);
    if (!stillHasCaptcha) {
      console.log('✅ 验证码已消失，疑似验证通过');
      return true;
    }

    // 如果验证失败，页面会显示"请完成人机验证"，需要重新点击签到续期按钮触发验证码
    console.log('🔄 验证失败，重新点击签到续期按钮触发验证码...');
    await page.waitForTimeout(1000);
    
    // 重新点击签到按钮
    const exactCheckinButton = page.locator('button#checkinBtn.ci-btn.renew');
    if (await exactCheckinButton.count() > 0) {
      await page.evaluate(() => {
        const button = document.querySelector('button#checkinBtn.ci-btn.renew');
        if (button) {
          button.click();
        }
      });
      console.log('🖱️ 重新点击签到按钮（JavaScript 执行）');
      await page.waitForTimeout(1000);
    }

    console.log(`⚠️ 第${attempt}轮处理后验证码仍存在，准备重试`);
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
    return true;
  }

  // 检查是否有密码输入框（未登录的标志）
  const hasPasswordInput = await page.locator('input#renewKey[type="password"]').count() > 0;
  if (hasPasswordInput) {
    // 如果有密码输入框，说明还没登录
    return false;
  }

  // 检查是否有登录按钮（未登录的标志）
  const hasLoginButton = await page.locator('button:has-text("登录"), button:has-text("Login")').count() > 0;
  if (hasLoginButton) {
    return false;
  }

  // 最后检查是否有签到按钮
  const hasCheckinBtn = await page.locator('button:has-text("签到续期"), button:has-text("签到"), button#checkinBtn.ci-btn.renew').count() > 0;
  const hasSignedBtn = await page.locator('button:has-text("今日已签到")').count() > 0;

  return hasCheckinBtn || hasSignedBtn;
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

    // 强制使用指定输入框：<input class="ci-input" id="renewKey" ...>
    const exactInput = page.locator('input#renewKey.ci-input[type="password"]');
    if (await exactInput.count() === 0) {
      console.log('❌ 未找到指定的 API Key 输入框 #renewKey.ci-input');
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
 * 处理滑动验证码 - 自定义拼图验证码
 * 使用 ddddocr 自动识别缺口位置
 * @param {import('playwright').Page} page - Playwright 页面实例
 * @returns {Promise<boolean>} 返回是否验证成功
 */
async function handleSliderCaptcha(page) {
  try {
    console.log('🔍 查找拼图滑动验证码...');
    
    // 等待验证码弹窗加载
    console.log('⏳ 等待验证码弹窗加载（3秒）...');
    await page.waitForTimeout(3000);
    
    // 通过 Playwright 定位滑块：特征是文字 "›"，圆角 999px
    let sliderHandle = null;
    
    // 方法1：使用 filter 找
    const filtered = page.locator('div').filter({
      hasText: /^›$/,
      visible: true
    });
    if (await filtered.count() > 0) {
      sliderHandle = filtered.first();
      console.log('✅ 找到拼图滑块（filter方法）');
    } else {
      // 方法2：直接找所有div，通过text内容找
      console.log('ℹ️ filter没找到，尝试直接查找...');
      const allDivs = await page.locator('div').elementHandles();
      for (const div of allDivs) {
        const text = await div.textContent();
        if (text && text.trim() === '›') {
          const isVisible = await div.isVisible();
          if (isVisible) {
            sliderHandle = div;
            console.log('✅ 找到拼图滑块（直接查找）');
            break;
          }
        }
      }
    }
    
    if (!sliderHandle) {
      console.log('❌ 未找到滑块');
      return false;
    }
    
    const isVisible = await sliderHandle.isVisible().catch(() => false);
    if (!isVisible) {
      console.log('❌ 滑块不可见');
      return false;
    }
    
    console.log('✅ 找到拼图滑块');
    
    // 获取滑块和验证码容器位置
    const handleBox = await sliderHandle.boundingBox();
    if (!handleBox) {
      console.log('❌ 无法获取滑块位置');
      return false;
    }
    
    let slideDistance = null;
    
    // 尝试用 ddddocr 识别
    try {
      // 获取验证码容器（滑块的祖父元素，包含整个拼图图片）
      let captchaContainer = sliderHandle.locator('..').locator('..');
      const containerBox = await captchaContainer.boundingBox().catch(() => null);
      
      if (containerBox) {
        // 截验证码图
        console.log('📸 截取验证码图片用于 ddddocr 识别...');
        const screenshot = await page.screenshot({
          clip: {
            x: containerBox.x,
            y: containerBox.y,
            width: containerBox.width,
            height: containerBox.height
          }
        });
        
        // 使用 ddddocr 识别缺口位置
         console.log('🔍 ddddocr 识别滑块缺口位置...');
         const result = ocr.detect(screenshot);
         console.log(`🎯 识别结果：缺口X坐标 = ${result}px`);
         
         // 计算滑动距离：result 就是目标X坐标（相对于容器）
         // 滑块起点X = 容器x + 滑块半径
         slideDistance = result - handleBox.width / 2;
      }
    } catch (ocrError) {
      console.log(`⚠️ ddddocr 识别失败：${ocrError.message}，回退到随机范围...`);
    }
    
    // 如果 ddddocr 识别失败，回退到随机重试
    if (slideDistance === null) {
      // 拼图验证码每次缺口位置都随机变化
      // 根据截图调整：缺口位置大约在 100px - 200px 范围
      // 放宽范围，增加随机性，提高命中概率
      slideDistance = 100 + Math.floor(Math.random() * 100);
      console.log(`🎲 ddddocr 识别失败，使用随机距离：${slideDistance.toFixed(0)}px`);
    }
    
    // 起始坐标（滑块中心）
    const startX = handleBox.x + handleBox.width / 2;
    const startY = handleBox.y + handleBox.height / 2;
    const endX = startX + slideDistance;
    
    console.log(`📏 拖动距离: ${slideDistance.toFixed(0)}px，从 (${startX.toFixed(0)}, ${startY.toFixed(0)}) 到 (${endX.toFixed(0)}, ${startY.toFixed(0)})`);
    
    // 使用鼠标操作，模拟人类拖动：分阶段移动 + 随机抖动 + 随机延迟
    await page.mouse.move(startX, startY);
    await page.waitForTimeout(50 + Math.random() * 100);
    await page.mouse.down();
    await page.waitForTimeout(50 + Math.random() * 50);
    
    // 分多步移动，模拟人类行为 - 增加延迟让拖动更自然
    const steps = 6 + Math.floor(Math.random() * 4);
    for (let i = 1; i <= steps; i++) {
      const currentX = startX + (slideDistance * (i / steps));
      const jitter = (Math.random() - 0.5) * 3;
      await page.mouse.move(currentX, startY + jitter, { steps: 15 });
      await page.waitForTimeout(100 + Math.random() * 150);
    }
    
    // 最后到位，稍微停留再松开
    const finalJitter = (Math.random() - 0.5) * 2;
    await page.mouse.move(endX, startY + finalJitter);
    await page.waitForTimeout(300 + Math.random() * 200);
    await page.mouse.up();
    
    console.log('✅ 滑块拖动完成，等待验证结果...');
    
    // 等待验证结果 - 需要更长时间让服务器验证和页面更新
    await page.waitForTimeout(5000);
    
    // 检查验证码是否还存在
    const stillHasCaptcha = await detectSliderCaptcha(page);
    if (stillHasCaptcha) {
      console.log('❌ 验证码仍然存在，验证失败');
      return false;
    }
    
    console.log('✅ 验证码已消失，验证成功');
    return true;
    
  } catch (error) {
    console.error(`❌ 处理滑动验证码时发生错误：${error.message}`);
    return false;
  }
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
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    
    const page = await context.newPage();
    
    // 监听页面日志
    page.on('console', msg => console.log(`📄 页面日志: ${msg.text()}`));
    page.on('pageerror', err => console.error(`❌ 页面错误: ${err.message}`));
    
    // 访问签到页面
    console.log(`🌐 正在访问签到页面: ${CHECKIN_URL}`);
    await page.goto(CHECKIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    console.log('✅ 页面加载完成');
    
    // 等待页面完全加载
    await page.waitForTimeout(2000);
    
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
