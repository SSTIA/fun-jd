import { argv } from 'yargs';
import { exec } from 'child-process-promise';
import format from 'string-format';
import path from 'path';
import fsp from 'fs-promise';
import lzma from 'lzma-native';
import api from 'libs/api';

const LZMA_DECOMPRESS_OPTIONS = {
  threads: 1,
};

export default async (mq, logger) => {

  if (argv.role !== 'match') {
    return;
  }

  const runtimeDir = path.resolve(DI.config.runtimeDirectory);
  await fsp.ensureDir(runtimeDir);

  async function handleJudgeTask(task) {
    try {
      await api.roundBegin(task.mdocid, task.rid);

      const matchConfig = { ...DI.config.match };
      const formatArgv = { matchConfig, task };
      matchConfig.s1bin = path.join(runtimeDir, format(matchConfig.s1bin, formatArgv));
      matchConfig.s2bin = path.join(runtimeDir, format(matchConfig.s2bin, formatArgv));
      matchConfig.map = path.join(runtimeDir, format(matchConfig.map, formatArgv));
      matchConfig.config = path.join(runtimeDir, format(matchConfig.config, formatArgv));

      await fsp.ensureDir(path.dirname(matchConfig.s1bin));
      await fsp.writeFile(matchConfig.s1bin, await lzma.decompress(await api.getSubmissionBinary(task.s1docid), LZMA_DECOMPRESS_OPTIONS));

      await fsp.ensureDir(path.dirname(matchConfig.s2bin));
      await fsp.writeFile(matchConfig.s2bin, await lzma.decompress(await api.getSubmissionBinary(task.s2docid), LZMA_DECOMPRESS_OPTIONS));

      await fsp.ensureDir(path.dirname(matchConfig.map));
      await fsp.writeFile(matchConfig.map, task.map);

      await fsp.ensureDir(path.dirname(matchConfig.config));
      await fsp.writeFile(matchConfig.config, JSON.stringify({
        'sandbox': DI.config.sandbox === null ? null : path.resolve(DI.config.sandbox),
        'board': matchConfig.map,
        'brain0.field': task.u1field,
        'brain0.bin': matchConfig.s1bin,
        'brain0.moveTimeout': task.rules.moveTimeout,
        'brain0.roundTimeout': task.rules.roundTimeout,
        'brain0.memoryLimit': task.rules.memoryLimit,
        'brain1.bin': matchConfig.s2bin,
        'brain1.moveTimeout': task.rules.moveTimeout,
        'brain1.roundTimeout': task.rules.roundTimeout,
        'brain1.memoryLimit': task.rules.memoryLimit,
        'width': task.rules.width,
        'height': task.rules.height,
        'winningStones': task.rules.winningStones,
      }, null, 2));

      let success, stdout, stderr, code = 0;
      try {
        const execResult = await exec(matchConfig.command, {
          cwd: runtimeDir,
          maxBuffer: 10 * 1024 * 1024,
        });
        stdout = execResult.stdout;
        stderr = execResult.stderr;
      } catch (err) {
        stdout = err.stdout;
        stderr = err.stderr;
        code = err.code;
      }
      if (code < 1 || code > 4) {
        throw new Error(`Unexpected judge exit code ${code}. ${stderr}`);
      }
      await api.roundComplete(task.mdocid, task.rid, code, stdout);
    } catch (err) {
      await api.roundError(task.mdocid, task.rid, `System internal error occured when judging this round.\n\n${err.stack}`);
      throw err;
    }
  }

  mq.subscribe('judge', (err, subscription) => {
    if (err) throw err;
    subscription.on('error', err => logger.error(err));
    subscription.on('message', async (message, task, ackOrNack) => {
      logger.info('Match', task);
      try {
        await handleJudgeTask(task);
      } catch (e) {
        logger.error(e);
      }
      ackOrNack();
    });
  });

  logger.info('Accepting match tasks...');

};
