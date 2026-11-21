// Claude Code's session registry records process start times in a Windows
// format, so a reused pid can't be told apart here yet: don't check.
const canCheckProc = () => false;
const processStartTimes = async () => null;

Object.assign(module.exports, {
  canCheckProc,
  processStartTimes
});
