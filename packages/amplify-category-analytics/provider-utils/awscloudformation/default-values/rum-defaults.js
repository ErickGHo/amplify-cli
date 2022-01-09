const uuid = require('uuid');

const getAllDefaults = project => {
  const appName = project.projectConfig.projectName.toLowerCase();
  const [shortId] = uuid().split('-');

  const authRoleName = {
    Ref: 'AuthRoleName',
  };

  const unauthRoleName = {
    Ref: 'UnauthRoleName',
  };

  const authRoleArn = {
    'Fn::GetAtt': ['AuthRole', 'Arn'],
  };

  const unauthRoleArn = {
    'Fn::GetAtt': ['UnauthRole', 'Arn'],
  };

  const defaults = {
    rumMonitorName: `${appName}Monitor`,
    enableCookies: true,
    sessionSampleRate: 100.00,
    enableCwLogs: false,
    telemetries: ["performance", "errors", "http"],
    enableXRay: false,
    authPolicyName: `rum_amplify_${shortId}`,
    unauthPolicyName: `rum_amplify_${shortId}`,
    authRoleName,
    unauthRoleName,
    unauthRoleArn,
    authRoleArn,
  };

  return defaults;
};

module.exports = {
  getAllDefaults,
};
