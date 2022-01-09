const inquirer = require('inquirer');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');

const category = 'analytics';
const parametersFileName = 'parameters.json';
const service = 'CloudWatch RUM';
const templateFileName = 'rum-cloudformation-template.json';
import {ResourceAlreadyExistsError, exitOnNextTick, UnknownArgumentError, ResourceDoesNotExistError} from 'amplify-cli-core';

async function addWalkthrough(context, defaultValuesFilename, serviceMetadata) {
  return configure(context, defaultValuesFilename, serviceMetadata);
}

function createQuestionPromptMap(amplifyContext, inputs, defaultValues, filter) {
  const questionMap = inputs.map(input => ({
    name: input.key,
    message: input.question,
    type: input.type || 'input',
    choices: input.options || undefined,
    required: input.required || false,
    validate: 'validation' in input ? amplifyContext.inputValidation(input) : undefined,
    default: () => {
      return defaultValues[input.key]
    },
  }));
  return filter ? questionMap.filter(filter) : questionMap;
// default: () => {
//     const defaultValue = defaultValues[input.key];
//     return Array.isArray(defaultValue) ? defaultValue.filter(v => v.value) : defaultValue
//   },
}

function configure(context, defaultValuesFilename, serviceMetadata, resourceName) {

  const {amplify} = context;
  const defaultValuesSrc = `${__dirname}/../default-values/${defaultValuesFilename}`;
  const {getAllDefaults} = require(defaultValuesSrc);
  const defaultValues = getAllDefaults(amplify.getProjectDetails());
  const projectBackendDirPath = amplify.pathManager.getBackendDirPath();

  const {inputs, advancedInputs} = serviceMetadata;

  // read existing parameters into default values
  if (resourceName) {
    const resourceDirPath = path.join(projectBackendDirPath, category, resourceName);
    const parametersFilePath = path.join(resourceDirPath, parametersFileName);
    const parameters = context.amplify.readJsonFile(parametersFilePath);
    Object.assign(defaultValues, parameters);
  }

  // when resourceName is provided, we are in update flow - only ask for domainName
  const initialQuestions = createQuestionPromptMap(amplify, inputs, defaultValues, (question) => resourceName && question.name === 'domainName' || !resourceName)

  return inquirer.prompt(initialQuestions).then(async answers => {

    const targetResourceName = resourceName || answers.rumMonitorName;
    const resourceDirPath = path.join(projectBackendDirPath, category, targetResourceName);

    if (!resourceName && resourceNameAlreadyExists(context, targetResourceName)) {
      const errMessage = `Resource ${targetResourceName} already exists in ${category} category.`;
      context.print.error(errMessage);
      await context.usageData.emitError(new ResourceAlreadyExistsError(errMessage));
      exitOnNextTick(0);
      return;
    }

    if (!answers.domainName.includes(".")) {
      const errMessage = `User input ${answers.domainName} is missing a domain name. i.e: example.com`;
      context.print.error(errMessage);
      await context.usageData.emitError(new UnknownArgumentError(errMessage));
      exitOnNextTick(0);
      return;
    }

    // Assign/Update users answers
    Object.assign(defaultValues, answers);

    const analyticsRequirements = {
      authSelections: 'identityPoolOnly',
      allowUnauthenticatedIdentities: true,
    };

    const checkResult = await amplify.invokePluginMethod(context, 'auth', undefined, 'checkRequirements', [
      analyticsRequirements,
      context,
      'analytics',
      targetResourceName,
    ]);

    // If auth is imported and configured, we have to throw the error instead of printing since there is no way to adjust the auth
    // configuration.
    if (checkResult.authImported === true && checkResult.errors && checkResult.errors.length > 0) {
      throw new Error(checkResult.errors.join(os.EOL));
    }

    if (checkResult.errors && checkResult.errors.length > 0) {
      context.print.warning(checkResult.errors.join(os.EOL));
    }

    // If auth is not imported and there were errors, adjust or enable auth configuration
    if (!checkResult.authEnabled || !checkResult.requirementsMet) {
      context.print.warning('Adding analytics would add the Auth category to the project if not already added.');
      if (
        await amplify.confirmPrompt(
          'Apps need authorization to send analytics events. Do you want to allow guests and unauthenticated users to send analytics events? (we recommend you allow this when getting started)',
        )
      ) {
        try {
          await amplify.invokePluginMethod(context, 'auth', undefined, 'externalAuthEnable', [
            context,
            'analytics',
            targetResourceName,
            analyticsRequirements,
          ]);
        } catch (error) {
          context.print.error(error);
          throw error;
        }
      } else {
        try {
          context.print.warning(
            'Authorize only authenticated users to send analytics events. Use "amplify update auth" to modify this behavior.',
          );
          analyticsRequirements.allowUnauthenticatedIdentities = false;
          await amplify.invokePluginMethod(context, 'auth', undefined, 'externalAuthEnable', [
            context,
            'analytics',
            targetResourceName,
            analyticsRequirements,
          ]);
        } catch (error) {
          context.print.error(error);
          throw error;
        }
      }
    }

    // At this point we have a valid auth configuration either imported or added/updated.
    if (resourceName || answers.configureAdvanced) { // In update flow or user specified to configure advanced
      const advancedQuestions = createQuestionPromptMap(amplify, advancedInputs, defaultValues);
      const advancedAnswers = await inquirer.prompt(advancedQuestions);
      Object.assign(defaultValues, advancedAnswers);
    }

    const projectResources = amplify.getProjectMeta();
    const authResources = projectResources.auth;
    const primaryAuthResourceName = Object.keys(authResources)[0];
    const authOutputs = authResources[primaryAuthResourceName].output;
    if (!authOutputs || !authOutputs.IdentityPoolId) {
      throw new Error('Identity Pool ID could not be identified, push auth first')
    }
    defaultValues.identityPoolId = authOutputs.IdentityPoolId;

    delete defaultValues.configureAdvanced; // No need to save this into parameters.json

    writeParams(resourceDirPath, defaultValues);
    writeCfnFile(context, resourceDirPath);
    return targetResourceName
  });
}

async function updateWalkthrough(context, defaultValuesFilename, serviceMetadata) {
  const {amplify} = context;
  const {allResources} = await amplify.getResourceStatus();
  const cloudwatchRumResources = allResources.filter(resource => resource.service === service).map(resource => resource.resourceName);

  let targetResourceName;
  if (cloudwatchRumResources.length === 0) {
    const errMessage = 'No Cloudwatch RUM resource to update. Please use "amplify add analytics" command to create a new RUM monitor';
    context.print.error(errMessage);
    await context.usageData.emitError(new ResourceDoesNotExistError(errMessage));
    exitOnNextTick(0);
    return;
  } else if (cloudwatchRumResources.length === 1) {
    [targetResourceName] = cloudwatchRumResources;
    context.print.success(`Selected resource ${targetResourceName}`);
  } else {
    const resourceQuestion = [
      {
        name: 'resourceName',
        message: 'Please select the CloudWatch RUM monitor you would want to update',
        type: 'list',
        choices: cloudwatchRumResources,
      },
    ];
    const answer = await inquirer.prompt(resourceQuestion);
    targetResourceName = answer.resourceName;
  }

  return configure(context, defaultValuesFilename, serviceMetadata, targetResourceName);
}

function resourceNameAlreadyExists(context, name) {
  const {amplify} = context;
  const {amplifyMeta} = amplify.getProjectDetails();
  return category in amplifyMeta ? Object.keys(amplifyMeta[category]).includes(name) : false;
}

function writeCfnFile(context, resourceDirPath, force = false) {
  fs.ensureDirSync(resourceDirPath);
  const templateFilePath = path.join(resourceDirPath, templateFileName);
  if (!fs.existsSync(templateFilePath) || force) {
    const templateSourceFilePath = `${__dirname}/../cloudformation-templates/${templateFileName}`;
    const templateSource = context.amplify.readJsonFile(templateSourceFilePath);
    const jsonString = JSON.stringify(templateSource, null, 4);
    fs.writeFileSync(templateFilePath, jsonString, 'utf8');
  }
}

function writeParams(resourceDirPath, values) {
  fs.ensureDirSync(resourceDirPath);
  const parametersFilePath = path.join(resourceDirPath, parametersFileName);
  const jsonString = JSON.stringify(values, null, 4);
  fs.writeFileSync(parametersFilePath, jsonString, 'utf8');
}

function getIAMPolicies(resourceName, crudOptions) {
  const actions = crudOptions
    .map(crudOption => {
      switch (crudOption) {
        case 'create':
          return ['rum:PutRumEvents'];
        default:
          console.log(`${crudOption} not supported`);
          return [];
      }
    })
    .reduce((flattened, rumActions) => [...flattened, ...rumActions], []);

  const policy = {
    Effect: 'Allow',
    Action: actions,
    Resource: [
      {
        'Fn::Join': [
          '',
          [
            'arn:aws:rum:',
            {
              Ref: `${category}${resourceName}Region`,
            },
            ':',
            {Ref: 'AWS::AccountId'},
            ':appmonitor/',
            {
              Ref: `${category}${resourceName}Id`,
            },
          ],
        ],
      },
    ],
  };

  const attributes = ['Id', 'Region'];

  return {policy, attributes};
}

module.exports = {addWalkthrough, updateWalkthrough, getIAMPolicies};
