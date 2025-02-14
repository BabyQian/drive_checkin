require("dotenv").config();
const log4js = require("log4js");
const recording = require("log4js/lib/appenders/recording");
const superagent = require("superagent");
const { CloudClient } = require("cloud189-sdk");
const env = require("./env");

log4js.configure({
  appenders: {
    vcr: { type: "recording" },
    out: {
      type: "console",
      layout: {
        type: "pattern",
        pattern: "\u001b[32m%d{yyyy-MM-dd hh:mm:ss}\u001b[0m - %m"
      }
    }
  },
  categories: { default: { appenders: ["vcr", "out"], level: "info" } }
});

const logger = log4js.getLogger();

const mask = (s, start, end) => s.split("").fill("*", start, end).join("");

// 重试请求的函数
const retryRequest = async (fn, retries = 2, delay = 10000) => {
  let attempt = 0;
  while (attempt < retries) {
    try {
      return await fn(); // 尝试执行传入的函数
    } catch (error) {
      attempt++;
      if (attempt < retries) {
        logger.warn(`请求失败，正在重试... 第 ${attempt} 次，等待 ${delay / 1000} 秒`);
        await new Promise((resolve) => setTimeout(resolve, delay)); // 延迟后重试
      } else {
        logger.error(`请求重试 ${retries} 次后仍失败`);
        throw error; // 如果重试次数用完，抛出错误
      }
    }
  }
};

const doTask = async (cloudClient) => {
  const result = [];
  let getSpace = [`${firstSpace}签到个人云获得(M)`];
  
  // 第一个号的个人云签到是单线程的
  if (env.private_only_first == false || i / 2 % 20 == 0) {
    const signPromises1 = [];
    for (let m = 0; m < private_threadx; m++) {
      signPromises1.push((async () => {
        try {
          const res1 = await retryRequest(() => cloudClient.userSign()); // 使用重试机制
          if (!res1.isSign) {
            getSpace.push(` ${res1.netdiskBonus}`);
          }
        } catch (e) {
          getSpace.push(` 0`);
        }
      })());
    }
    await Promise.all(signPromises1);
    if (getSpace.length == 1) getSpace.push(" 0");
    result.push(getSpace.join(""));
  }

  // 第一个号的家庭云签到是单线程的
  const signPromises2 = [];
  getSpace = [`${firstSpace}签到家庭云获得(M)`];
  const { familyInfoResp } = await cloudClient.getFamilyList();
  if (familyInfoResp) {
    const family = familyInfoResp.find((f) => f.familyId == familyID) || familyInfoResp[0];
    result.push(`${firstSpace}开始签到家庭云 ID: ${family.familyId}`);
    
    // 如果是第一个号且 private_only_first 为 true，使用单线程执行
    if (env.private_only_first && i / 2 == 0) {
      for (let m = 0; m < 1; m++) {  // 单线程执行
        try {
          const res = await retryRequest(() => cloudClient.familyUserSign(family.familyId)); // 使用重试机制
          if (!res.signStatus) {
            getSpace.push(` ${res.bonusSpace}`);
          }
        } catch (e) {
          getSpace.push(` 0`);
        }
      }
    } else {
      // 对于其他账户或 private_only_first 为 false，使用多线程执行
      for (let m = 0; m < family_threadx; m++) {
      signPromises2.push((async () => {
        try {
          const res = await cloudClient.familyUserSign(family.familyId);
          if (!res.signStatus) {
            getSpace.push(` ${res.bonusSpace}`);
          }
        } catch (e) {
          getSpace.push(` 0`);
          }
        })());
      }
      await Promise.all(signPromises2);
    }
    if (getSpace.length == 1) getSpace.push(" 0");
    result.push(getSpace.join(""));
  }
  return result;
};

// 登录时使用重试机制
const loginWithRetry = async (cloudClient) => {
  try {
    await retryRequest(() => cloudClient.login(), 2, 10000); // 使用 5 次重试，每次间隔 30 秒
    //logger.info("登录成功");
  } catch (e) {
    logger.error(`登录失败：${e.message}`);
    throw e; // 登录失败就跳过当前账号
  }
};

// 执行任务时使用重试机制
const doTaskWithRetry = async (cloudClient) => {
  try {
    return await retryRequest(() => doTask(cloudClient), 2, 10000); // 使用 5 次重试，每次间隔 30 秒
  } catch (e) {
    logger.error(`执行任务失败：${e.message}`);
    return []; // 返回空结果，跳过当前账号
  }
};

const pushTelegramBot = (title, desp) => {
  if (!(telegramBotToken && telegramBotId)) {
    return;
  }
  const data = {
    chat_id: telegramBotId,
    text: `${title}\n\n${desp}`,
  };
  superagent
    .post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`)
    .send(data)
    .timeout(3000)
    .end((err, res) => {
      if (err) {
        logger.error(`TelegramBot推送失败:${JSON.stringify(err)}`);
        return;
      }
      const json = JSON.parse(res.text);
      if (!json.ok) {
        logger.error(`TelegramBot推送失败:${JSON.stringify(json)}`);
      } else {
        logger.info("TelegramBot推送成功");
      }
    });
};

const pushWxPusher = (title, desp) => {
  if (!(WX_PUSHER_APP_TOKEN && WX_PUSHER_UID)) {
    return;
  }
  const data = {
    appToken: WX_PUSHER_APP_TOKEN,
    contentType: 1,
    summary: title,
    content: desp,
    uids: [WX_PUSHER_UID],
  };
  superagent
    .post("https://wxpusher.zjiecode.com/api/send/message")
    .send(data)
    .timeout(30000)
    .end((err, res) => {
      if (err) {
        logger.error(`wxPusher推送失败:${JSON.stringify(err)}`);
        return;
      }
      const json = JSON.parse(res.text);
      if (json.data[0].code !== 1000) {
        logger.error(`wxPusher推送失败:${JSON.stringify(json)}`);
      } else {
        logger.info("wxPusher推送成功");
      }
    });
};

const push = (title, desp) => {
  pushWxPusher(title, desp);
  pushTelegramBot(title, desp);
};

let firstSpace = "  ";
let familyID;

let accounts = env.tyys;
let familyIDs = env.FAMILY_ID.split(/[\n ]/);

let WX_PUSHER_UID = env.WX_PUSHER_UID;
let WX_PUSHER_APP_TOKEN = env.WX_PUSHER_APP_TOKEN;

let telegramBotToken = env.TELEGRAM_BOT_TOKEN;
let telegramBotId = env.TELEGRAM_CHAT_ID;

let private_threadx = env.private_threadx; //进程数
let family_threadx = env.family_threadx; //进程数

let i = 0;

const main = async () => {
  accounts = accounts.split(/[\n ]/);

 let userName0, password0, familyCapacitySize, cloudCapacitySize;

  for (i = 0; i < accounts.length; i += 2) {
    let n = parseInt(i / 2 / 20);
    familyID = familyIDs[n];
    const [userName, password] = accounts.slice(i, i + 2);
    if (!userName || !password) continue;

    const userNameInfo = mask(userName, 3, 7);

    try {
      const cloudClient = new CloudClient(userName, password);

      logger.log(`${i / 2 + 1}.账户 ${userNameInfo} 开始执行`);
      await loginWithRetry(cloudClient);  // 使用重试机制登录
    
      const { cloudCapacityInfo: cloudCapacityInfo0, familyCapacityInfo: familyCapacityInfo0 } = await cloudClient.getUserSizeInfo();
      const result = await doTaskWithRetry(cloudClient);  // 使用重试机制执行任务

      if (i / 2 % 20 == 0) {
        userName0 = userName;
        password0 = password;
        familyCapacitySize = familyCapacityInfo0.totalSize;
        cloudCapacitySize = cloudCapacityInfo0.totalSize;
      }
      const { cloudCapacityInfo, familyCapacityInfo } = await cloudClient.getUserSizeInfo();
      result.forEach((r) => logger.log(r));

    } catch (e) {
      logger.error(`账户 ${userNameInfo} 执行失败：${e.message}`);
    } finally {
      logger.log("");  // 确保每个账户执行结束后打印空行
    }

    if (i / 2 % 20 == 19 || i + 2 == accounts.length) {
      if (!userName0 || !password0) continue;
      const cloudClient = new CloudClient(userName0, password0);
      await cloudClient.login();
      const userNameInfo = mask(userName0, 3, 7);
      const { cloudCapacityInfo: finalCloudCapacityInfo, familyCapacityInfo: finalfamilyCapacityInfo } = await cloudClient.getUserSizeInfo();
      
    const cloudCapacityChange = finalCloudCapacityInfo.totalSize - cloudCapacitySize;
      const capacityChange = finalfamilyCapacityInfo.totalSize - familyCapacitySize;
      logger.log(`本次签到${userNameInfo} 个人获得 ${cloudCapacityChange / 1024 / 1024}M`); // 新增
      logger.log(`本次签到${userNameInfo} 家庭获得 ${capacityChange / 1024 / 1024}M \n`);
        
      const { cloudCapacityInfo, familyCapacityInfo } = await cloudClient.getUserSizeInfo();
      const personalTotalCapacity = (cloudCapacityInfo.totalSize / 1024 / 1024 / 1024).toFixed(2);  
      const familyTotalCapacity = (familyCapacityInfo.totalSize / 1024 / 1024 / 1024).toFixed(2);    
      logger.log(`${firstSpace}现主号${userNameInfo}个人：${personalTotalCapacity} GB`);
      logger.log(`${firstSpace}现主号${userNameInfo}家庭：${familyTotalCapacity} GB`);
    }
  }
};

(async () => {
  try {
    await main();
  } finally {
    logger.log("\n\n");
    const events = recording.replay();
    const content = events.map((e) => `${e.data.join("")}`).join("  \n");
    push("天翼云盘自动签到任务", content);
    recording.erase();
  }
})();
