import { test } from "node:test";
import assert from "node:assert/strict";
import { awsErrorCode } from "../src/aws-lease.ts";
import { guardLambdaMicrovms } from "../src/backends/aws.ts";
import { capture } from "../src/util.ts";

function failure(script: string): unknown {
  try {
    capture(process.execPath, ["-e", script]);
  } catch (error) {
    return error;
  }
  return assert.fail("the command should have failed");
}

test("awsErrorCode reads the error code from the AWS CLI's JSON error output, past any warnings", () => {
  const error = failure(
    `console.error("urllib3 InsecureRequestWarning"); console.error(JSON.stringify({ Code: "ResourceNotFoundException", Message: "no such secret" }, null, 4)); process.exit(254);`,
  );
  assert.equal(awsErrorCode(error), "ResourceNotFoundException");
});

test("awsErrorCode maps the CLI's parameter-validation exit status, whose usage text is never JSON", () => {
  const error = failure(
    `console.error("aws: [ERROR]: argument command: Found invalid choice 'lambda-microvms'"); process.exit(252);`,
  );
  assert.equal(awsErrorCode(error), "ParamValidation");
  assert.throws(() => guardLambdaMicrovms(error), /lacks the `lambda-microvms` commands/);
});

test("awsErrorCode does not guess from legacy error text", () => {
  const legacy = failure(
    `console.error("An error occurred (ResourceNotFoundException) when calling the GetSecretValue operation"); process.exit(254);`,
  );
  assert.equal(awsErrorCode(legacy), undefined);
  assert.equal(awsErrorCode(new Error("ResourceNotFoundException")), undefined);
  const other = failure(`console.error(JSON.stringify({ Code: "ThrottlingException" })); process.exit(254);`);
  assert.throws(
    () => guardLambdaMicrovms(other),
    (error: unknown) => error === other,
  );
});
