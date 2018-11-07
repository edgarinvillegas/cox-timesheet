const puppeteer = require('puppeteer');

let cfg = null;

/**
 * Get the configuration object.
 * It reads from args/env/file and creates the file if it doesn't exist.
 * @returns {*}
 */
function config() {
    const fs    = require('fs');
    const nconf = require('nconf');
    const conf_defaults = {
        "username": "",
        "password": "",
        "project": "PRJ0020909",
        "category": "Development",
        "hours": {
            "monday": 8,
            "tuesday": 8,
            "wednesday": 8,
            "thursday": 8,
            "friday": 8
        }
    };
    const conf_file = './config.json';    // __dirname + '/config.json'
    if( ! fs.existsSync(conf_file) ) {
        fs.writeFileSync( conf_file, JSON.stringify(conf_defaults, null, 2) );
    }
    nconf.file({file: conf_file});
    nconf.argv()
        .env()
        .file({ file: conf_file })
        .defaults(conf_defaults);

    return nconf.get(null);
}


function extendPageWithJQuery(page){
    return Object.assign(page, {
        /**
         * The page needs to have window.jQuery defined.
         * Equivalent to page.waitForSelector but admits jQuery selectors (like ':contains')
         * @returns {ReturnTypeOf<waitForSelector>}
         */
        waitForJqSelector: (selector, options = {}) => page.waitFor(
            (selector => window.jQuery(selector).length),
        options, selector),
        /**
         * The page needs to have window.jQuery defined.
         * page.triggerJqEvent('button#myBtn', 'mousedown')
         * @param {string} selector
         * @param {string} eventName
         * @returns {Promise<void>} Same promise as page.evaluate
         */
        triggerJqEvent: (selector, eventName) => page.evaluate((selector, eventName) => {
            window.jQuery(selector).trigger(eventName);
        }, selector, eventName)

    })
}

async function createPage() {
    // Viewport && Window size
    const width = 1200;
    const height = 768;

    const browser = await puppeteer.launch({
        headless: false,
        args: [
            `--window-size=${ width },${ height }`
        ],
    });

    const page = extendPageWithJQuery(await browser.newPage());
    // Initial page
    await page.setViewport({width, height});
    return page;
}

function transformAddTimecardPostData(originalPostData) {
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
    Object.keys(cfg.hours).forEach( day => values.timecards[0][day] = String(cfg.hours[day]));
    // Encode back
    const valuesJsonStr = JSON.stringify(values);
    console.log('new Values', valuesJsonStr);
    return `values=${encodeURIComponent(valuesJsonStr)}`;
}



(async () => {
    // Load configuration from file.
    cfg = config();
    // Load the page
    const page = await createPage();
    await page.goto('https://coxauto.service-now.com/time', {waitUntil: 'networkidle2'});
    // Some redirections might happen, so better to make sure that the username textbox exists
    await page.waitForSelector('#okta-signin-username');
    await page.screenshot({path: '01 login-page.png'});

    // Now we're on the login page. Enter credentials
    await page.type('#okta-signin-username', cfg.username);
    await page.type('#okta-signin-password', cfg.password);

    // Submit the form
    await page.click('input[type="submit"]');

    // This will go to another page, wait until it loads
    await page.waitForSelector('.navpage-layout');

    // The current page has the page we want as framed in. Let's go to it
    await page.goto('https://coxauto.service-now.com/time', {waitUntil: 'networkidle2'});

    //************************************* Go temporarily to previous page
    // await page.waitForSelector('.date-selector button.icon-chevron-left');
    // await page.click('.date-selector button.icon-chevron-left');
    // await page.waitForJqSelector('.date-selector:contains(28 October)');

    // Just in case wait for the project cards container
    await page.waitForSelector('.cards-panel-body');
    await page.screenshot({path: '02 final-page.png'});

    // Wait until we have the 'Add Line' button
    const projectCardSelector = `.card:contains(${cfg.project})`;
    const addLineBtnSelector = `${projectCardSelector} button:contains(Add Line Item)`;

    // Click on the Add Line button
    await page.waitForJqSelector(addLineBtnSelector);
    await page.triggerJqEvent(addLineBtnSelector, 'click');
    await page.screenshot({path: '03 Add Line clicked.png'});

    // Wait until the 'Select time category' dropdown appears
    const categoryDropdownSelector = `${projectCardSelector} .select2-container.project-category`;
    // Click on the 'Select time category' dropdown, and get the projectId
    await page.waitForJqSelector(`${categoryDropdownSelector} .select2-arrow`);
    await page.triggerJqEvent(`${categoryDropdownSelector} .select2-arrow`, 'mousedown');

    // Wait until the dropdown opens
    await page.waitForSelector('ul.select2-results li.select2-result-selectable');
    await page.screenshot({path: '04 Select category dropdown opened.png'});
    // Click on the configured time category
    await page.triggerJqEvent(`ul.select2-results li.select2-result-selectable div:contains(${cfg.category})`, 'mouseup');
    await page.screenshot({path: '04 Select category dropdown opened.png'});
    // Start request interception to spoof hours
    await page.setRequestInterception(true);
    page.on('request', interceptedRequest => {
        if (interceptedRequest.url().includes('/timecardprocessor.do?sysparm_name=addToTimesheet&sysparm_processor=TimeCardPortalService')){
            console.log('Intercepted /timecardprocessor.do');
            interceptedRequest.continue({
                postData: transformAddTimecardPostData(interceptedRequest.postData())
            });
        } else {
            interceptedRequest.continue();
        }
    });
    // Click on the 'Add Time' button
    await page.triggerJqEvent(`${projectCardSelector} button.btn-primary:contains(Add Time)`, 'click');
    // Make sure the row was added
    await page.waitForSelector(`.tc-row`);
    await page.screenshot({path: '05 Timecard added.png'});

    // Get the total accumulated hours by day. Useful for validation. Won't be needed once we implement pre cleanup
    const totalDailyHours = await page.evaluate(() => {
        return window.jQuery('#cal-container-1 .cal-container-4').map( (i, e) => parseInt($(e).text().trim()) ).get();
    });
    const totalHours = totalDailyHours.reduce( (prev, curr) => prev+curr );
    const totalIntendedHours = Object.values(cfg.hours).reduce( (prev, curr) => prev+curr );
    if(totalHours !== totalIntendedHours) {
        console.log('Error. Intended hours: ', totalIntendedHours, 'Actual hours: ', totalHours, '. Please submit your timesheet manually');
        await page.screenshot({path: '06 Error - Times dont match.png'});
        // await browser.close();
        return;
    }
    console.log('Ready to submit!!');
    // await page.triggerJqEvent('.sp-row-content button.btn-primary:contains(Submit)', 'click');
    // await page.waitForJqSelector('.sp-row-content a:contains(PDF)');
    // await page.screenshot({path: '07 Submitted'});
    console.log('Done');
    // await browser.close();
})();