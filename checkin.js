/**
 * 自动签到脚本 - Playwright 版本
 * 用于GitHub Actions定时执行，自动访问指定网站完成签到操作
 */

require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');

// 获取密钥
const CHECKIN_KEY = process.env.CHECKIN_KEY;
if (!CHECKIN_KEY) {
  console.error('❌ 未设置CHECKIN_KEY环境变量');
  process.exit(1);
}

// 签到网站URL
const CHECKIN_URL = 'https://gpt.qt.cool/checkin';

/**
 * 主签到函数
 */
async function autoCheckin() {
  let browser = null;
  
  try {
    console.log('🚀 开始执行自动签到脚本');
    
    // 启动浏览器
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
    
    // 截图记录初始状态
    await page.screenshot({ path: '1_initial.png', fullPage: true });
    console.log('📸 已保存初始状态截图: 1_initial.png');
    
    // 检查是否已经登录（是否有"签到"或"签到续期"按钮或"今日已签到"按钮）
    const hasCheckinButton1 = await page.locator('button:has-text("签到续期")').count() > 0;
    const hasCheckinButton2 = await page.locator('button:has-text("签到")').count() > 0;
    const hasSignedButton = await page.locator('button:has-text("今日已签到")').count() > 0;
    
    const hasCheckinButton = hasCheckinButton1 || hasCheckinButton2;
    
    if (hasCheckinButton) {
      console.log('✅ 检测到已登录状态');
    } else if (hasSignedButton) {
      console.log('🎉 检测到今日已签到状态');
      return true;
    } else {
      console.log('🔐 未登录，需要先登录');
      
      // 在右侧"登录签到续期"区域输入密钥
      // 找到密码输入框 - 优先使用精确选择器
      console.log('🔍 寻找API Key输入框...');
      
      // 尝试精确选择器
      const exactInput = page.locator('input.ci-input#renewKey[type="password"]');
      if (await exactInput.count() > 0) {
        console.log('✅ 找到精确的API Key输入框');
        await exactInput.fill(CHECKIN_KEY);
        console.log('✅ 成功输入密钥');
      } else {
        // 尝试其他选择器
        const passwordInputs = await page.locator('input[type="password"]').all();
        
        if (passwordInputs.length === 0) {
          console.error('⚠️ 未找到密码输入框，尝试使用其他选择器');
          // 尝试其他可能的密码输入框选择器
          const otherInputs = await page.locator('input[type="text"], input[placeholder*="API"], input[placeholder*="key"]').all();
          if (otherInputs.length === 0) {
            throw new Error('无法找到密码输入框');
          }
          // 使用最后一个输入框
          const targetInput = otherInputs[otherInputs.length - 1];
          await targetInput.fill(CHECKIN_KEY);
          console.log('✅ 成功输入密钥（使用备用选择器）');
        } else {
          // 使用最后一个密码输入框（通常是右侧的）
          const targetInput = passwordInputs[passwordInputs.length - 1];
          await targetInput.fill(CHECKIN_KEY);
          console.log('✅ 成功输入密钥');
        }
      }
      
      // 截图记录输入后状态
      await page.screenshot({ path: '2_after_input.png', fullPage: true });
      
      // 点击登录按钮 - 尝试多种选择器
      console.log('🖱️ 寻找登录按钮...');
      const loginButtonSelectors = [
        'button.ci-btn.renew',
        'button:has-text("登录")',
        'button[type="submit"]',
        'button:has-text("确认")',
        'button:has-text("提交")'
      ];
      
      let loginButtonFound = false;
      for (const selector of loginButtonSelectors) {
        console.log(`尝试选择器: ${selector}`);
        const button = page.locator(selector);
        const count = await button.count();
        console.log(`找到 ${count} 个元素`);
        if (count > 0) {
          console.log(`✅ 找到登录按钮: ${selector}`);
          try {
            await button.click({ timeout: 5000 });
            loginButtonFound = true;
            break;
          } catch (error) {
            console.error(`点击按钮失败: ${error.message}`);
            continue;
          }
        }
      }
      
      if (!loginButtonFound) {
        console.error('⚠️ 未找到登录按钮，尝试点击页面中所有按钮');
        // 尝试点击所有按钮，看是否有登录功能
        const allButtons = await page.locator('button').all();
        console.log(`找到 ${allButtons.length} 个按钮`);
        for (let i = 0; i < allButtons.length; i++) {
          const button = allButtons[i];
          let text = '';
          try {
            text = await button.textContent();
          } catch (error) {
            text = `按钮${i+1}`;
          }
          console.log(`尝试点击按钮: ${text}`);
          try {
            await button.click({ timeout: 3000 });
          } catch (error) {
            console.error(`点击按钮失败: ${error.message}`);
            continue;
          }
          await page.waitForTimeout(1000);
          // 检查是否登录成功
          const hasCheckinBtn = await page.locator('button:has-text("签到续期")').count() > 0;
          const hasSignedBtn = await page.locator('button:has-text("今日已签到")').count() > 0;
          if (hasCheckinBtn || hasSignedBtn) {
            console.log('✅ 登录成功！');
            loginButtonFound = true;
            break;
          }
        }
      }
      
      if (!loginButtonFound) {
        throw new Error('无法找到登录按钮');
      }
      
      console.log('🖱️ 点击登录按钮完成');
      
      // 等待登录完成
      await page.waitForTimeout(3000);
      
      // 检查是否有"签到"或"签到续期"按钮（即使隐藏也能找到）
      const checkinButton = page.locator('button#checkinBtn.ci-btn.renew');
      const buttonCount = await checkinButton.count();
      if (buttonCount > 0) {
        console.log('✅ 登录成功，检测到签到按钮');
      } else {
        // 尝试"签到续期"按钮
        const renewCheckinButton = page.locator('button:has-text("签到续期")');
        const renewCount = await renewCheckinButton.count();
        if (renewCount > 0) {
          console.log('✅ 登录成功，检测到"签到续期"按钮');
        } else {
          // 尝试"签到"按钮
          const checkinButtonAlt = page.locator('button:has-text("签到")');
          const checkinCount = await checkinButtonAlt.count();
          if (checkinCount > 0) {
            console.log('✅ 登录成功，检测到"签到"按钮');
          } else {
            throw new Error('登录后未找到签到按钮');
          }
        }
      }
    }
    
    // 截图记录登录后状态
    await page.screenshot({ path: '3_logged_in.png', fullPage: true });
    
    // 点击"签到"或"签到续期"按钮 - 优先使用精确选择器
    console.log('🖱️ 寻找并点击签到按钮...');
    
    // 尝试精确选择器 - 使用JavaScript执行点击
    const exactCheckinButton = page.locator('button#checkinBtn.ci-btn.renew');
    if (await exactCheckinButton.count() > 0) {
      console.log('✅ 找到精确的签到按钮');
      await page.evaluate(() => {
        const button = document.querySelector('button#checkinBtn.ci-btn.renew');
        if (button) {
          button.click();
        }
      });
      console.log('🖱️ 点击签到按钮（JavaScript执行）');
    } else {
      // 尝试"签到续期"按钮 - 使用JavaScript执行点击
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
        console.log('🖱️ 点击签到续期按钮（JavaScript执行）');
      } else {
        // 尝试"签到"按钮 - 使用JavaScript执行点击
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
          console.log('🖱️ 点击签到按钮（JavaScript执行）');
        } else {
          throw new Error('未找到签到按钮');
        }
      }
    }
    
    // 等待验证码或结果出现
    console.log('⏳ 等待验证码或结果出现...');
    await page.waitForTimeout(5000);
    
    // 截图查看是否出现验证码
    await page.screenshot({ path: '4_after_click.png', fullPage: true });
    console.log('📸 已保存点击后截图: 4_after_click.png');
    
    // 检查是否出现滑动验证码
    const hasSliderCaptcha = await page.locator('.captcha-slider, .slider-captcha, [class*="slider"][class*="captcha"]').count() > 0;
    
    if (hasSliderCaptcha) {
      console.log('🔐 检测到滑动验证码，开始处理...');
      await handleSliderCaptcha(page);
      // 处理完验证码后再等待结果
      console.log('⏳ 等待验证码处理结果...');
      await page.waitForTimeout(5000);
    } else {
      console.log('ℹ️ 未检测到滑动验证码');
      // 等待签到结果
      console.log('⏳ 等待签到结果...');
      await page.waitForTimeout(5000);
      
      // 刷新页面以确保状态更新
      console.log('🔄 刷新页面以更新签到状态...');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
    }
    
    // 截图记录最终结果
    await page.screenshot({ path: '5_final_result.png', fullPage: true });
    console.log('📸 已保存最终结果截图: 5_final_result.png');
    
    // 检查签到成功状态
    console.log('🔍 检查签到成功状态...');
    
    // 1. 检查页面是否有"今日已签到"按钮
    const hasSignedButtonFinal = await page.locator('button:has-text("今日已签到")').count() > 0;
    if (hasSignedButtonFinal) {
      console.log('🎉 检测到"今日已签到"按钮，签到成功！');
      return true;
    }
    
    // 2. 检查签到日历中今天是否有标记
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
    
    // 3. 检查页面是否有成功提示
    const pageContent = await page.content();
    if (pageContent.includes('签到成功') || pageContent.includes('今日已签到')) {
      console.log('🎉 检测到签到成功提示');
      return true;
    }
    
    // 4. 检查按钮文本是否变为"今日已签到"
    const checkinButton = page.locator('button#checkinBtn.ci-btn.renew');
    if (await checkinButton.count() > 0) {
      const buttonText = await checkinButton.textContent();
      if (buttonText && (buttonText.includes('今日已签到') || buttonText.includes('已签到'))) {
        console.log(`🎉 检测到按钮状态变为: ${buttonText}`);
        return true;
      }
    }
    
    console.log('⚠️ 未检测到明确的签到成功标志');
    return false;
    
  } catch (error) {
    console.error(`❌ 签到过程中发生错误: ${error.message}`);
    
    // 尝试保存错误截图
    if (browser) {
      try {
        const pages = await browser.pages();
        if (pages.length > 0) {
          await pages[0].screenshot({ path: 'error_screenshot.png', fullPage: true });
          console.log('📸 已保存错误页面截图: error_screenshot.png');
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

/**
 * 处理滑动验证码
 * @param {Page} page - Playwright页面实例
 */
async function handleSliderCaptcha(page) {
  try {
    console.log('🔍 查找验证码元素...');
    
    // 等待验证码元素出现
    const captchaSelectors = [
      '.captcha-slider',
      '.slider-captcha',
      '[class*="slider"]'
    ];
    
    let captchaElement = null;
    
    for (const selector of captchaSelectors) {
      const element = page.locator(selector).first();
      if (await element.count() > 0) {
        captchaElement = element;
        console.log(`✅ 找到验证码元素: ${selector}`);
        break;
      }
    }
    
    if (!captchaElement) {
      console.log('⚠️ 未找到验证码元素，可能不需要处理');
      return;
    }
    
    // 查找滑块
    const sliderHandle = captchaElement.locator('.slider-handle, .handle, [class*="handle"]').first();
    
    if (await sliderHandle.count() === 0) {
      console.log('⚠️ 未找到滑块元素');
      return;
    }
    
    console.log('🖱️ 开始拖动滑块...');
    
    // 获取滑块位置
    const handleBox = await sliderHandle.boundingBox();
    
    if (!handleBox) {
      throw new Error('无法获取滑块位置');
    }
    
    // 获取验证码容器位置
    const captchaBox = await captchaElement.boundingBox();
    
    if (!captchaBox) {
      throw new Error('无法获取验证码容器位置');
    }
    
    // 计算滑动距离（滑到最右边）
    const slideDistance = captchaBox.width - handleBox.width - 10;
    
    // 拖动滑块
    await sliderHandle.dragTo(sliderHandle, {
      force: true,
      targetPosition: { x: slideDistance, y: 0 }
    });
    
    console.log('✅ 滑块拖动完成');
    
    // 等待验证结果
    await page.waitForTimeout(3000);
    
  } catch (error) {
    console.error(`❌ 处理滑动验证码时发生错误: ${error.message}`);
    // 不抛出错误，继续执行
  }
}

// 执行签到
(async () => {
  try {
    console.log('========== 🚀 开始签到测试（Playwright版本） ==========');
    const success = await autoCheckin();
    
    if (success) {
      console.log('✅ 签到成功完成');
      process.exit(0);
    } else {
      console.log('⚠️ 签到完成，但可能未成功');
      process.exit(0);
    }
  } catch (error) {
    console.error(`❌ 签到失败: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
})();
