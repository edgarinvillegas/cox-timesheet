const dateFns = require('date-fns');

const weekdayNames = require('./constants').weekdayNames;
const logger = require('./lib/logger');
const sendMail$ = require('./lib/sendMail');


async function automate({ page, cfg, credentials, targetDate = new Date() }){
    logger.log('Going to https://coxauto.service-now.com/time...');
    await page.goto('https://coxauto.service-now.com/time', {waitUntil: 'networkidle2'});
    // Login
    {
        // Some redirections might happen, so better to make sure that the username textbox exists
        await page.waitForSelector('#okta-signin-username');
        logger.log(`Logging in ${credentials.coxEmail}...`);
        // await page.screenshot({path: '01 login-page.png'});

        // Now we're on the login page. Enter credentials
        await page.type('#okta-signin-username', credentials.coxEmail);
        await page.type('#okta-signin-password', credentials.coxPassword);

        // Submit the form
        await page.click('input[type="submit"]');
    }

    // Go to timesheet page
    {
        // This will go to another page, wait until it loads
        await page.waitForSelector('.navpage-layout');

        logger.log(`Loading timesheet page...`);
        // The current page has the page we want as framed in. Let's go to it
        await page.goto('https://coxauto.service-now.com/time', {waitUntil: 'networkidle2'});

        await page.waitForSelector('.date-selector button.icon-chevron-left');
    }

    // Go to correct date
    {
        //************************************* Go temporarily to previous page
        const targetDateText = getWeekPickerText(targetDate);
        logger.log(`Going to week "${targetDateText}"...`);

        const getCurrentDateText$ = () => page.getTextJq('.date-selector .date-range [role=heading]');

        async function weekBack$(){
            const dateText = await getCurrentDateText$();
            await page.click('.date-selector button.icon-chevron-left');
            await page.waitForJqSelector(`.date-selector:not(:contains(${dateText}))`)
        }
        while( !(await getCurrentDateText$()).startsWith(targetDateText) ){
            await weekBack$();
        }
    }

    // Check timesheet status. If not PENDING, abort.
    {
        //It can be PENDING, SUBMITED, PROCESSED
        const timesheetState = (await page.getTextJq('.tcp-header .ts-data:contains(State) .ts-val')).toUpperCase();
        if(timesheetState !== 'PENDING') {
            // TODO: analyze if this should throw
            throw new Error(`No need to submit timesheet "${getWeekPickerText(targetDate)}" because it's in ${timesheetState} state`);
        }
    }

    // Timesheet filling
    {
        async function getLoggedHours$() {
            return await page.evaluate(() => {
                return window.jQuery('#cal-container-1 .cal-container-4').map( (i, e) => parseInt($(e).text().trim()) ).get();
            });
        }

        // TODO: remove param
        async function getHourDifference$(intendedHours) {
            // Get the total accumulated hours by day. Useful for validation. Won't be needed once we implement pre cleanup
            const actualTotalDailyHours = await getLoggedHours$();
            const actualTotalDailyHoursObj = {}, differences = {};
            weekdayNames.forEach( (day, i) =>  {
                actualTotalDailyHoursObj[day] = actualTotalDailyHours[i];
                differences[day] = (intendedHours[day] || 0) - actualTotalDailyHoursObj[day];
            });
            if(Object.values(differences).some( h => h < 0 )){
                logger.log('Error. Intended hours: ', JSON.stringify(intendedHours), '\nCurrently logged: ', JSON.stringify(actualTotalDailyHoursObj), '.\nPlease submit your timesheet manually');
            }
            return differences;
        }

        function getIntendedHours() {
            const intendedHours = {};
            weekdayNames.forEach( (day, i) =>  {
                intendedHours[day] = getDayIntendedHours(targetDate, i, cfg.defaultHours[day], cfg.exceptionalHours);
            });
            return intendedHours;
        }
        const intendedHours = getIntendedHours();

        logger.log(`Filling timesheet...`);
        const hourDifferences = await getHourDifference$(intendedHours);
        // If there's a negative difference, it means we cannot submit it. TODO: Add automatic timesheet wipe to avoid this
        if(Object.values(hourDifferences).some( h => h < 0 )) {
            // await page.screenshot({path: '06 Error - Times dont match.png'});
            throw new Error(`Cannot log configured hours`);
        } else if (Object.values(hourDifferences).every( h => h === 0)) {
            logger.log(`Already logged desired hours: ${JSON.stringify(intendedHours)}. Skipping logging`);
        } else {
            // Just in case wait for the project cards container
            await page.waitForSelector('.cards-panel-body');
            // await page.screenshot({path: '02 final-page.png'});

            // Wait until we have the 'Add Line' button
            logger.log(`Selecting project ${cfg.project}...`);
            const projectCardSelector = `.card:contains(${cfg.project})`;
            const addLineBtnSelector = `${projectCardSelector} button:contains(Add Line Item)`;

            // Click on the Add Line button
            await page.waitForJqSelector(addLineBtnSelector);
            await page.triggerJqEvent(addLineBtnSelector, 'click');
            // await page.screenshot({path: '03 Add Line clicked.png'});

            // Wait until the 'Select time category' dropdown appears
            logger.log(`Selecting category ${cfg.category}...`);
            const categoryDropdownSelector = `${projectCardSelector} .select2-container.project-category`;
            // Click on the 'Select time category' dropdown, and get the projectId
            await page.waitForJqSelector(`${categoryDropdownSelector} .select2-arrow`);
            await page.triggerJqEvent(`${categoryDropdownSelector} .select2-arrow`, 'mousedown');

            // Wait until the dropdown opens
            await page.waitForSelector('ul.select2-results li.select2-result-selectable');
            // await page.screenshot({path: '04 Select category dropdown opened.png'});
            // Click on the configured time category
            await page.triggerJqEvent(`ul.select2-results li.select2-result-selectable div:contains(${cfg.category})`, 'mouseup');
            // await page.screenshot({path: '04 Select category dropdown opened.png'});
            // Start request interception to spoof hours
            logger.log(`Logging hours to have ${JSON.stringify(intendedHours)}...`);
            await page.setRequestInterception(true);
            page.on('request', interceptedRequest => {
                if (interceptedRequest.url().includes('/timecardprocessor.do?sysparm_name=addToTimesheet&sysparm_processor=TimeCardPortalService')){
                    // logger.log('Intercepted /timecardprocessor.do');
                    interceptedRequest.continue({
                        postData: transformAddTimecardPostData(interceptedRequest.postData(), hourDifferences)
                    });
                } else {
                    interceptedRequest.continue();
                }
            });
            // Click on the 'Add Time' button
            await page.triggerJqEvent(`${projectCardSelector} button.btn-primary:contains(Add Time)`, 'click');
            // Make sure the row was added
            await page.waitForSelector(`.tc-row:contains(${cfg.project})`);
            // await page.screenshot({path: '05 Timecard added.png'});
        }

        logger.log('Ready to submit...');

        await page.triggerJqEvent('.sp-row-content button.btn-primary:contains(Submit)', 'click');
        await page.waitForJqSelector('.sp-row-content a:contains(PDF)');
        logger.log('Submitted succesfully.');
        //
        const finalScreenshot = 'submitted.png';
        await page.screenshot({path: finalScreenshot});
        logger.log(`Sending emails...`);
        await sendEmail$(credentials.mojixEmail, credentials.mojixPassword, cfg.emailSettings, targetDate, [`./${finalScreenshot}`]);
        logger.log('SUCCESS.');
    }
}

/**
 * Returns the weekday of the targetDate's week, formatted
 * For example, if tomorrow is Thursday, Nov 9, 2018
 * then getFormattedDateByWeekday(new Date(), 3) will return '2018-11-09' (3 = thursday)
 * @param targetDate A date of the week
 * @param weekday 0 for sunday, 1 for monday, etc
 * @returns {string}
 */
function getFormattedDateByWeekday(targetDate, weekday) {
    return dateFns.format(dateFns.startOfWeek(targetDate, {weekStartsOn: weekday}), 'YYYY-MM-DD');
}

function getDayIntendedHours(targetDate, weekday, hdefault, exceptionalHours) {
    if(hdefault === undefined) return 0;    // To return 0 on weekends
    const formattedDate = getFormattedDateByWeekday(targetDate, weekday);
    let ret = hdefault;
    for(let dateRange in exceptionalHours){
        const value = exceptionalHours[dateRange];
        const startDate = dateRange.split(':')[0].trim();
        const endDate = (dateRange.split(':')[1] || startDate).trim();
        if(startDate <= formattedDate && formattedDate <= endDate) {
            ret = value;
        }
    }
    return ret;
}

function sendEmail$(mojixEmail, mojixPassword, emailSettings, targetDate, files) {
    //logger.log('emailSettings: ', emailSettings);
    const saturdayDate = dateFns.format(dateFns.endOfWeek(targetDate), 'YYYY-MM-DD');
    return sendMail$({
        user: mojixEmail,
        pass: mojixPassword,
        to:   emailSettings.to,
        cc: emailSettings.cc,
        bcc: emailSettings.bcc,            // almost any option of `nodemailer` will be passed to it
        subject: emailSettings.subjectTemplate.replace('{weekendDate}', saturdayDate),
        text:    `TEST Timesheet for ${saturdayDate} has been submitted succesfully.`,         // Plain text
        //html:    '<b>html text</b>'            // HTML
        files: files,
    });
}

function transformAddTimecardPostData(originalPostData, hours) {
    //Decode originalPostData
    const urlEncodedValuesComponent = originalPostData.split('values=')[1];
    const values = JSON.parse(decodeURIComponent(urlEncodedValuesComponent));
    /*
    values looks like:
    {
        "timecards": [
            {
                "monday": "8",
                "tuesday": "8",
                "wednesday": "8",
                "thursday": "8",
                "friday": "8",
                "time_sheet": "37274231db61ab40b94169c3ca961995",
                "category": "task_work",
                "task": "e0dfbc03db2cef406062dff648961958",
                "project_time_category": "9e7e8b024f20cf0027ac04c85210c702"
            }
        ],
        "timesheetId": "37274231db61ab40b94169c3ca961995",
        "action": "quick_add"
    }
    */
    //Update each day hours based on the config. It modifies values
    Object.keys(hours).forEach( day => values.timecards[0][day] = String(hours[day]));
    // Encode back
    const valuesJsonStr = JSON.stringify(values);
    // logger.log('new Values', valuesJsonStr);
    return `values=${encodeURIComponent(valuesJsonStr)}`;
}

function getWeekPickerText(date = new Date()){
    const startDate = dateFns.startOfWeek(date);
    const endDate = dateFns.endOfWeek(date);
    const [startYear, startMonth, startDay] = dateFns.format(startDate, 'YYYY MMMM D').split(' ');
    const [endYear, endMonth, endDay] = dateFns.format(endDate, 'YYYY MMMM D').split(' ');
    /*
    * 3 scenarios to support:
    * 18 - 24 November 2018
    * 25 November - 1 December 2018
    * 30 December 2018 - 5 January 2019
    * */
    const startMonthUI = startMonth === endMonth ? '' : `${startMonth} `;
    const startYearUI = startYear === endYear ? '': `${startYear} `;
    return `${startDay} ${startMonthUI}${startYearUI}- ${endDay} ${endMonth} ${endYear}`;
}

module.exports = automate;