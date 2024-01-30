// eslint-disable-next-line import/no-import-module-exports
import nconf from 'nconf';
// eslint-disable-next-line import/no-import-module-exports
import winston from 'winston';
// eslint-disable-next-line import/no-import-module-exports
import validator from 'validator';
// eslint-disable-next-line import/no-import-module-exports
import translator from '../translator';
// eslint-disable-next-line import/no-import-module-exports
import plugins from '../plugins';
// eslint-disable-next-line import/no-import-module-exports
import middleware from '../middleware';
// eslint-disable-next-line import/no-import-module-exports
import middlewareHelpers from '../middleware/helpers';
// eslint-disable-next-line import/no-import-module-exports
import helpers from './helpers';

const relative_path: string = nconf.get('relative_path') as string;

interface CustomRequest extends Request {
    path: string,
    originalUrl: string
}

interface CustomError extends Error {
    status: string,
    path: string,
    code: number
}

export async function handleURIErrors(err: CustomError, req: CustomRequest, res: any, next: any) {
    // Handle cases where malformed URIs are passed in
    if (err instanceof URIError) {
        const cleanPath: string = req.path.replace(new RegExp(`^${relative_path}`), '');
        const tidMatch = cleanPath.match(/^\/topic\/(\d+)\//);
        const cidMatch = cleanPath.match(/^\/category\/(\d+)\//);

        if (tidMatch) {
            res.redirect(relative_path + tidMatch[0]);
        } else if (cidMatch) {
            res.redirect(relative_path + cidMatch[0]);
        } else {
            winston.warn(`[controller] Bad request: ${req.path}`);
            if (req.path.startsWith(`${relative_path}/api`)) {
                res.status(400).json({
                    error: '[[global:400.title]]',
                });
            } else {
                await middleware.buildHeaderAsync(req, res);
                res.status(400).render('400', { error: validator.escape(String(err.message)) });
            }
        }
    } else {
        next(err);
    }
};

// this needs to have four arguments or express treats it as `(req, res, next)`
// don't remove `next`!
exports.handleErrors = async function handleErrors(err: CustomError, req: CustomRequest, res: any, next: any) { // eslint-disable-line no-unused-vars
    const cases = {
        EBADCSRFTOKEN: function () {
            winston.error(`${req.method} ${req.originalUrl}\n${err.message}`);
            res.sendStatus(403);
        },
        'blacklisted-ip': function () {
            res.status(403).type('text/plain').send(err.message);
        },
    };
    const defaultHandler = async function () {
        if (res.headersSent) {
            return;
        }
        // Display NodeBB error page
        const status = parseInt(err.status, 10);
        if ((status === 302 || status === 308) && err.path) {
            return res.locals.isAPI ? res.set('X-Redirect', err.path).status(200).json(err.path) : res.redirect(relative_path + err.path);
        }

        const path = String(req.path || '');

        if (path.startsWith(`${relative_path}/api/v3`)) {
            let status = 500;
            if (err.message.startsWith('[[')) {
                status = 400;
                err.message = await translator.translate(err.message);
            }
            return helpers.formatApiResponse(status, res, err);
        }

        winston.error(`${req.method} ${req.originalUrl}\n${err.stack}`);
        res.status(status || 500);
        const data = {
            path: validator.escape(path),
            error: validator.escape(String(err.message)),
            bodyClass: middlewareHelpers.buildBodyClass(req, res),
        };
        if (res.locals.isAPI) {
            res.json(data);
        } else {
            await middleware.buildHeaderAsync(req, res);
            res.render('500', data);
        }
    };
    const data = await getErrorHandlers(cases);
    try {
        if (data.cases.hasOwnProperty(err.code)) {
            data.cases[err.code](err, req, res, defaultHandler);
        } else {
            await defaultHandler();
        }
    } catch (_err) {
        winston.error(`${req.method} ${req.originalUrl}\n${_err.stack}`);
        if (!res.headersSent) {
            res.status(500).send(_err.message);
        }
    }
};

async function getErrorHandlers(cases) {
    try {
        return await plugins.hooks.fire('filter:error.handle', {
            cases: cases,
        });
    } catch (err) {
        // Assume defaults
        winston.warn(`[errors/handle] Unable to retrieve plugin handlers for errors: ${err.message}`);
        return { cases };
    }
}
